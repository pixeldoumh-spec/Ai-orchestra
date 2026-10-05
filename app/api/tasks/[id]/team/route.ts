import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";
import { assignTaskTeam } from "@/lib/collaboration/repository";
import { appendAuditLog } from "@/lib/enterprise/repository";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requireUser();
    const { id } = await context.params;
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "team.manage")) return NextResponse.json({ error: "Team assignment requires owner/admin role" }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const teamId = body.teamId === null ? null : typeof body.teamId === "string" ? body.teamId : undefined;
    if (teamId === undefined) return NextResponse.json({ error: "teamId is required; use null to unassign" }, { status: 400 });
    const task = await assignTaskTeam({ organizationId: org.id, taskId: id, teamId });
    await appendAuditLog({ organizationId: org.id, actorType: "user", actorId: user.id, action: "task.team.updated", resourceType: "task", resourceId: id, metadata: { teamId } });
    return NextResponse.json({ task });
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Task team update failed" }, { status });
  }
}
