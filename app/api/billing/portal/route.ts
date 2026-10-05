import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { createStripeBillingPortal } from "@/lib/billing/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  try {
    const { db, user } = await requireUser();
    const body = await request.json().catch(() => ({}));
    const org = await getOrganizationForUser(db, user.id, body.organizationId ?? new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "billing.manage")) {
      return NextResponse.json({ error: "Billing administration requires owner/admin/billing role" }, { status: 403 });
    }
    const admin = createAdminClient();
    const { data: customer } = await admin.from("billing_customers").select("external_customer_id").eq("organization_id", org.id).maybeSingle();
    if (!customer?.external_customer_id) return NextResponse.json({ error: "No Stripe billing customer exists for this workspace" }, { status: 409 });
    const session = await createStripeBillingPortal(customer.external_customer_id, new URL(request.url).origin + "/billing");
    return NextResponse.json({ url: session.url });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Billing portal creation failed" }, { status });
  }
}
