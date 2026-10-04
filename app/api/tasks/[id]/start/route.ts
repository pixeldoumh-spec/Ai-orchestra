import { NextResponse } from "next/server";
import { getOrganizationForUser, requireUser } from "@/lib/auth";
import { getTask, appendEvent } from "@/lib/orchestrator/repository";
import { enqueueTask } from "@/lib/orchestrator/queue";
import { markTaskDispatched } from "@/lib/ops/repository";
import { hasEnterprisePermission } from "@/lib/enterprise/rbac";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requireUser();
    const { id } = await context.params;
    const org = await getOrganizationForUser(db, user.id, new URL(request.url).searchParams.get("organizationId"));
    if (!org) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    if (!hasEnterprisePermission(org.role, "runtime.run")) {
      return NextResponse.json({ error: "Runtime execution permission is required" }, { status: 403 });
    }

    const task = await getTask(id, org.id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (["verified", "failed", "cancelled", "awaiting_approval"].includes(task.status)) {
      return NextResponse.json({ accepted: false, dispatchId: null, task }, { status: 200 });
    }

    try {
      const { dispatchId } = await enqueueTask({
        taskId: id,
        organizationId: org.id,
        reason: "user_start",
      });
      await markTaskDispatched(id, dispatchId);
      await appendEvent(id, org.id, "task.dispatched", {
        dispatchId,
        reason: "user_start",
        queue: "ai-orchestra-tasks-v66",
      });
      const refreshed = await getTask(id, org.id);
      return NextResponse.json({ accepted: true, dispatchId, task: refreshed }, { status: 202 });
    } catch (error) {
      await appendEvent(id, org.id, "task.dispatch_failed", {
        error: error instanceof Error ? error.message.slice(0, 240) : "Task queue unavailable",
      }).catch(() => {});
      return NextResponse.json({ error: error instanceof Error ? error.message : "Task queue unavailable" }, { status: 503 });
    }
  } catch (error) {
    const status = error instanceof Response ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
