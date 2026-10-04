import { NextResponse } from "next/server";
import { digestEqual } from "@/lib/core/security";
import { getTask, appendEvent } from "@/lib/orchestrator/repository";
import { processTask } from "@/lib/orchestrator/worker";
import { startBackgroundWorkerRun, finishBackgroundWorkerRun } from "@/lib/ops/repository";

export async function POST(request: Request) {
  const configured = process.env.BACKGROUND_WORKER_SECRET;
  const supplied = request.headers.get("x-background-worker-secret") ?? "";
  if (!configured || !(await digestEqual(configured, supplied))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
    const dispatchId = typeof body.dispatchId === "string" ? body.dispatchId : "";
    const attempt = Number.isFinite(Number(body.attempt)) ? Math.max(1, Math.floor(Number(body.attempt))) : 1;
    const queueMessageId = typeof body.queueMessageId === "string" ? body.queueMessageId : null;
    if (!taskId || !organizationId || !dispatchId) {
      return NextResponse.json({ error: "taskId, organizationId and dispatchId are required" }, { status: 400 });
    }

    const workerId = `queue_${queueMessageId ?? crypto.randomUUID()}`;
    const run = await startBackgroundWorkerRun({
      organizationId,
      taskId,
      dispatchId,
      workerId,
      trigger: "queue",
      attempt,
    });
    try {
      const result = await processTask(taskId, organizationId, workerId);
      const task = result.task ?? await getTask(taskId, organizationId);
      await finishBackgroundWorkerRun({
        id: run.id,
        status: result.workerError ? "failed" : result.claimed ? "completed" : "skipped",
        startedAt: run.startedAt,
        metadata: {
          dispatchId,
          queueMessageId,
          claimed: result.claimed,
          taskStatus: task?.status ?? null,
        },
      });
      if (result.workerError) {
        return NextResponse.json(
          { ok: false, retryable: true, task, claimed: result.claimed },
          { status: 503 },
        );
      }
      return NextResponse.json({ ok: true, task, claimed: result.claimed });
    } catch (error) {
      await finishBackgroundWorkerRun({
        id: run.id,
        status: "failed",
        startedAt: run.startedAt,
        errorClass: "runtime",
        metadata: { dispatchId, queueMessageId },
      }).catch(() => {});
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Background execution failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
