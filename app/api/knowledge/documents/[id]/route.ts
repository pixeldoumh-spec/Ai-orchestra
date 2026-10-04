import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { getKnowledgeDocument, refreshKnowledgeDocumentStatus } from "@/lib/knowledge/repository";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requireUser();
    const { id } = await context.params;
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    const org = await getOrganizationForUser(db, user.id, organizationId);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) {
      return NextResponse.json({ error: "Runtime permission is required" }, { status: 403 });
    }
    const doc = await getKnowledgeDocument(org.id, id);
    if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
    const refreshed = doc.status === "indexing"
      ? await refreshKnowledgeDocumentStatus(org.id, id)
      : doc;
    return NextResponse.json({ document: refreshed });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status },
    );
  }
}
