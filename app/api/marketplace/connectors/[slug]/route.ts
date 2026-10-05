import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { uninstallMarketplaceConnector } from "@/lib/connectors/marketplace";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { appendAuditLog } from "@/lib/enterprise/repository";

export async function DELETE(request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { db, user } = await requireUser();
    const { slug } = await context.params;
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org || !hasEnterprisePermission(org.role, "enterprise.manage")) {
      return NextResponse.json({ error: "Marketplace administration requires owner/admin role" }, { status: 403 });
    }
    const install = await uninstallMarketplaceConnector({ organizationId: org.id, catalogSlug: slug });
    await appendAuditLog({ organizationId: org.id, actorType: "user", actorId: user.id, action: "marketplace.connector.uninstalled", resourceType: "connector_marketplace_catalog", resourceId: slug });
    return NextResponse.json({ install });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Connector uninstall failed" }, { status });
  }
}
