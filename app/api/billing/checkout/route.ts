import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { createStripeCheckout, createStripeCustomer, resolveStripePriceId } from "@/lib/billing/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { appendAuditLog } from "@/lib/enterprise/repository";

export async function POST(request: Request) {
  try {
    const { db, user } = await requireUser();
    const body = await request.json().catch(() => ({}));
    const planCode = typeof body.planCode === "string" ? body.planCode.trim() : "";
    const interval = body.interval === "year" ? "year" : "month";
    const org = await getOrganizationForUser(db, user.id, body.organizationId ?? null);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "billing.manage")) {
      return NextResponse.json({ error: "Billing administration requires owner/admin/billing role" }, { status: 403 });
    }
    const admin = createAdminClient();
    const { data: plan, error: planError } = await admin.from("product_plans").select("*").eq("code", planCode).eq("published", true).single();
    if (planError || !plan) return NextResponse.json({ error: "Product plan not found" }, { status: 404 });
    if (plan.billing_mode === "free" || plan.code === "starter") {
      return NextResponse.json({ error: "Starter is provisioned without checkout" }, { status: 400 });
    }
    const priceId = resolveStripePriceId(plan, interval);
    if (!priceId) {
      return NextResponse.json({ error: `No Stripe price is configured for ${plan.code} (${interval})` }, { status: 409 });
    }

    const { data: existing } = await admin.from("billing_customers").select("external_customer_id").eq("organization_id", org.id).maybeSingle();
    let customerId = existing?.external_customer_id ?? null;
    if (!customerId) {
      const customer = await createStripeCustomer({ organizationId: org.id, email: user.email, name: org.name });
      customerId = String(customer.id);
      await admin.from("billing_customers").upsert({
        organization_id: org.id,
        provider: "stripe",
        external_customer_id: customerId,
        email: user.email ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "organization_id" });
    }

    const origin = new URL(request.url).origin;
    const session = await createStripeCheckout({
      customerId,
      priceId,
      organizationId: org.id,
      planCode: plan.code,
      interval,
      successUrl: origin + "/billing?checkout=success",
      cancelUrl: origin + "/billing?checkout=cancelled",
    });
    await appendAuditLog({
      organizationId: org.id,
      actorType: "user",
      actorId: user.id,
      action: "billing.checkout.created",
      resourceType: "product_plan",
      resourceId: plan.code,
      metadata: { interval },
    });
    return NextResponse.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Checkout creation failed" }, { status });
  }
}
