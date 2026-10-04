import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import {
  ingestKnowledgeDocument,
  listKnowledgeDocuments,
} from "@/lib/knowledge/repository";

export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser();
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    const org = await getOrganizationForUser(db, user.id, organizationId);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) {
      return NextResponse.json({ error: "Runtime permission is required" }, { status: 403 });
    }
    return NextResponse.json({ documents: await listKnowledgeDocuments(org.id) });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status },
    );
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requireUser();
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    const org = await getOrganizationForUser(db, user.id, organizationId);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) {
      return NextResponse.json({ error: "Runtime permission is required" }, { status: 403 });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A multipart file field named 'file' is required" }, { status: 400 });
    }

    const result = await ingestKnowledgeDocument({
      organizationId: org.id,
      createdBy: user.id,
      file,
    });

    return NextResponse.json(
      result,
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status },
    );
  }
}
