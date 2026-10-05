import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { getBillingOverview } from "@/lib/billing/repository";

export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser();
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "billing.read")) {
      return NextResponse.json({ error: "Billing access denied" }, { status: 403 });
    }
    return NextResponse.json({ organization: org, ...(await getBillingOverview(org.id)) });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
