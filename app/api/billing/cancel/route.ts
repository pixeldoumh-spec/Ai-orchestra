import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { cancelStripeSubscription } from "@/lib/billing/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { appendAuditLog } from "@/lib/enterprise/repository";

export async function POST(request: Request) {
  try {
    const { db, user } = await requireUser();
    const body = await request.json().catch(() => ({}));
    const org = await getOrganizationForUser(db, user.id, body.organizationId ?? null);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "billing.manage")) {
      return NextResponse.json({ error: "Billing administration requires owner/admin/billing role" }, { status: 403 });
    }

    const admin = createAdminClient();
    const { data: subscription } = await admin.from("billing_subscriptions")
      .select("id,external_subscription_id,status,cancel_at_period_end")
      .eq("organization_id", org.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!subscription?.external_subscription_id) {
      return NextResponse.json({ error: "No Stripe subscription is active for this workspace" }, { status: 409 });
    }
    if (subscription.cancel_at_period_end) {
      return NextResponse.json({ scheduled: true, current: subscription });
    }

    const updated = await cancelStripeSubscription(subscription.external_subscription_id);
    await appendAuditLog({
      organizationId: org.id,
      actorType: "user",
      actorId: user.id,
      action: "billing.subscription.cancel_scheduled",
      resourceType: "billing_subscription",
      resourceId: subscription.id,
    });
    return NextResponse.json({ scheduled: true, subscription: updated });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Subscription cancellation failed" }, { status });
  }
}
