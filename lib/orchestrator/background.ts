import { createAdminClient } from "@/lib/supabase/admin";
import { appendEvent } from "./repository";
import { enqueueTask } from "./queue";
import { markTaskDispatched, startBackgroundWorkerRun, finishBackgroundWorkerRun } from "@/lib/ops/repository";

function hydrateRuntimeEnvironment(runtimeEnv?: unknown) {
  if (!runtimeEnv || typeof runtimeEnv !== "object") return;
  for (const [key, value] of Object.entries(runtimeEnv as Record<string, unknown>)) {
    if (typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(key)) {
      process.env[key] = value;
    }
  }
}

export async function dispatchDueTasks(runtimeEnv: unknown, trigger: "cron" | "manual" = "cron") {
  hydrateRuntimeEnvironment(runtimeEnv);
  const db = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - 45_000).toISOString();
  const limit = Math.min(25, Math.max(1, Number(process.env.BACKGROUND_DISPATCH_LIMIT ?? "12")));
  const { data: candidates, error } = await db
    .from("tasks")
    .select("id,organization_id,status,run_after,lease_until,last_dispatched_at,execution_mode")
    .in("status", ["queued", "running"])
    .eq("execution_mode", "background")
    .or(`run_after.is.null,run_after.lte.${nowIso}`)
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(limit * 4);
  if (error) throw new Error(error.message);

  const eligible = (candidates ?? [])
    .filter((task) => !task.last_dispatched_at || Date.parse(task.last_dispatched_at) <= Date.parse(cutoffIso))
    .slice(0, limit);

  const dispatched: Array<{ taskId: string; dispatchId: string }> = [];
  for (const task of eligible) {
    const { dispatchId } = await enqueueTask({
      taskId: task.id,
      organizationId: task.organization_id,
      reason: "cron_redrive",
      runtimeEnv,
    });
    await markTaskDispatched(task.id, dispatchId);
    await appendEvent(task.id, task.organization_id, "task.dispatched", {
      dispatchId,
      reason: trigger === "cron" ? "cron_redrive" : "manual_redrive",
      queue: "ai-orchestra-tasks-v66",
    });
    dispatched.push({ taskId: task.id, dispatchId });
  }
  return { checked: candidates?.length ?? 0, dispatched, timestamp: nowIso };
}

export async function executeQueuedTask(input: {
  taskId: string;
  organizationId: string;
  dispatchId: string;
  queueMessageId: string;
  attempt: number;
  runtimeEnv: unknown;
}) {
  hydrateRuntimeEnvironment(input.runtimeEnv);
  const workerId = `queue_${input.queueMessageId}`;
  const run = await startBackgroundWorkerRun({
    organizationId: input.organizationId,
    taskId: input.taskId,
    dispatchId: input.dispatchId,
    workerId,
    trigger: "queue",
    attempt: input.attempt,
  });
  const startedAt = run.startedAt;
  let telemetryFinished = false;
  try {
    const { processTask } = await import("./worker");
    const result = await processTask(input.taskId, input.organizationId, workerId, input.runtimeEnv);
    const db = createAdminClient();
    const { data: task } = await db
      .from("tasks")
      .select("status")
      .eq("id", input.taskId)
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    await finishBackgroundWorkerRun({
      id: run.id,
      status: result.workerError ? "failed" : result.claimed ? "completed" : "skipped",
      startedAt,
      metadata: {
        dispatchId: input.dispatchId,
        queueMessageId: input.queueMessageId,
        claimed: result.claimed,
        taskStatus: task?.status ?? null,
      },
    });
    telemetryFinished = true;
    if (result.workerError) {
      throw new Error("Background task execution returned a retryable worker failure");
    }
    return result;
  } catch (error) {
    if (telemetryFinished) throw error;
    await finishBackgroundWorkerRun({
      id: run.id,
      status: "failed",
      startedAt,
      errorClass: "runtime",
      metadata: {
        dispatchId: input.dispatchId,
        queueMessageId: input.queueMessageId,
      },
    }).catch(() => {});
    throw error;
  }
}
