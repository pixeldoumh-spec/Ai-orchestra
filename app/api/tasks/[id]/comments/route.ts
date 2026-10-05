import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { addTaskComment, listTaskComments } from "@/lib/collaboration/repository";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requireUser();
    const { id } = await context.params;
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "enterprise.read")) return NextResponse.json({ error: "Workspace access denied" }, { status: 403 });
    return NextResponse.json({ comments: await listTaskComments(org.id, id) });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Comments unavailable" }, { status });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requireUser();
    const { id } = await context.params;
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) return NextResponse.json({ error: "Task collaboration is unavailable for this role" }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const comment = await addTaskComment({
      organizationId: org.id,
      taskId: id,
      teamId: typeof body.teamId === "string" ? body.teamId : null,
      authorId: user.id,
      body: String(body.body ?? ""),
    });
    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Comment failed" }, { status });
  }
}
