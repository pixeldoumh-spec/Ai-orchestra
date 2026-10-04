import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { createMemory, listMemories } from "@/lib/knowledge/memory";

export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser();
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    const org = await getOrganizationForUser(db, user.id, organizationId);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) return NextResponse.json({ error: "Runtime permission is required" }, { status: 403 });
    return NextResponse.json({ memories: await listMemories(org.id, user.id) });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requireUser();
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    const org = await getOrganizationForUser(db, user.id, organizationId);
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) return NextResponse.json({ error: "Runtime permission is required" }, { status: 403 });

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.content !== "string") return NextResponse.json({ error: "content is required" }, { status: 400 });
    const kind = body.kind === "preference" || body.kind === "decision" || body.kind === "procedure" || body.kind === "context" ? body.kind : "fact";
    const visibility = body.visibility === "private" ? "private" : "workspace";

    const result = await createMemory({
      organizationId: org.id,
      userId: user.id,
      kind,
      visibility,
      content: body.content,
      sourceType: body.sourceType === "task" || body.sourceType === "document" || body.sourceType === "agent" ? body.sourceType : "user",
      sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : null,
      confidence: typeof body.confidence === "number" ? body.confidence : 1,
      importance: typeof body.importance === "number" ? body.importance : 50,
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata as Record<string, unknown> : {},
    });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
