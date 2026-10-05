import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { verifyStripeSignature } from "@/lib/billing/stripe";
import { finalizeBillingEvent, recordBillingEvent, saveStripeCustomer, upsertStripeInvoice, upsertStripeSubscription } from "@/lib/billing/repository";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Stripe webhook secret is not configured" }, { status: 503 });

  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  if (!verifyStripeSignature(payload, signature, secret, Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS ?? "300"))) {
    return NextResponse.json({ error: "Invalid Stripe signature" }, { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: "Invalid webhook JSON" }, { status: 400 });
  }
  const eventId = typeof event?.id === "string" ? event.id : "";
  const eventType = typeof event?.type === "string" ? event.type : "";
  if (!eventId || !eventType) return NextResponse.json({ error: "Stripe event id/type missing" }, { status: 400 });

  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const recorded = await recordBillingEvent({ eventId, eventType, payloadHash, payload: event });
  if (recorded.duplicate && recorded.status === "processed") return NextResponse.json({ received: true, duplicate: true });

  try {
    const object = event?.data?.object;
    switch (eventType) {
      case "checkout.session.completed": {
        const organizationId = typeof object?.metadata?.organization_id === "string" ? object.metadata.organization_id : null;
        if (organizationId && typeof object?.customer === "string") {
          await saveStripeCustomer({
            organizationId,
            externalCustomerId: object.customer,
            email: typeof object?.customer_details?.email === "string" ? object.customer_details.email : null,
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await upsertStripeSubscription(object);
        break;
      case "invoice.created":
      case "invoice.finalized":
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.voided":
      case "invoice.marked_uncollectible":
        await upsertStripeInvoice(object);
        break;
      default:
        await finalizeBillingEvent(eventId, "ignored");
        return NextResponse.json({ received: true, ignored: true });
    }
    await finalizeBillingEvent(eventId, "processed");
    return NextResponse.json({ received: true });
  } catch (error) {
    await finalizeBillingEvent(eventId, "failed", error instanceof Error ? error.message.slice(0, 500) : "Webhook processing failed").catch(() => {});
    return NextResponse.json({ error: error instanceof Error ? error.message : "Webhook processing failed" }, { status: 500 });
  }
}
