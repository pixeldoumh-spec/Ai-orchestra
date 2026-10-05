import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { listMarketplace, installMarketplaceConnector } from "@/lib/connectors/marketplace";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { appendAuditLog } from "@/lib/enterprise/repository";

export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser();
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    const marketplace = await listMarketplace(org.id);
    return NextResponse.json({ organization: org, ...marketplace });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Marketplace unavailable" }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requireUser();
    const body = await request.json().catch(() => ({}));
    const org = await getOrganizationForUser(db, user.id, body.organizationId ?? null);
    if (!org || !hasEnterprisePermission(org.role, "enterprise.manage")) {
      return NextResponse.json({ error: "Marketplace installation requires owner/admin role" }, { status: 403 });
    }
    const catalogSlug = typeof body.catalogSlug === "string" ? body.catalogSlug.trim() : "";
    if (!catalogSlug) return NextResponse.json({ error: "catalogSlug is required" }, { status: 400 });
    const install = await installMarketplaceConnector({
      organizationId: org.id,
      catalogSlug,
      userId: user.id,
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
    });
    await appendAuditLog({ organizationId: org.id, actorType: "user", actorId: user.id, action: "marketplace.connector.installed", resourceType: "connector_marketplace_catalog", resourceId: catalogSlug });
    return NextResponse.json({ install }, { status: 201 });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Connector installation failed" }, { status });
  }
}
