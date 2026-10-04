import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { recordRetrieval, retrieveKnowledge } from "@/lib/knowledge/memory";

export async function POST(request: Request) {
  try {
    const { db, user } = await requireUser();
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    const org = await getOrganizationForUser(db, user.id, organizationId);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) {
      return NextResponse.json({ error: "Runtime permission is required" }, { status: 403 });
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 });

    const limit = typeof body?.limit === "number" ? body.limit : 8;
    const results = await retrieveKnowledge({
      organizationId: org.id,
      userId: user.id,
      query,
      limit,
      workspaceOnly: body?.includePrivate !== true,
    });

    const memories = results.filter((row: any) => row.source_type === "memory");
    const documents = results.filter((row: any) => row.source_type === "document");

    await recordRetrieval({
      organizationId: org.id,
      userId: user.id,
      taskId: typeof body?.taskId === "string" ? body.taskId : null,
      query,
      memoryCount: memories.length,
      documentCount: documents.length,
    });

    return NextResponse.json({
      query,
      results,
      memories,
      documents,
      boundaries: {
        organizationId: org.id,
        privateMemoryIncluded: body?.includePrivate === true,
        privateMemoryOwner: user.id,
      },
    });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
