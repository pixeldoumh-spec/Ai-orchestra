import { createAdminClient } from "@/lib/supabase/admin";
import { appendEvent, recoverStaleTaskLease } from "./repository";
import { enqueueTask, newDispatchId } from "./queue";
import { startBackgroundWorkerRun, finishBackgroundWorkerRun } from "@/lib/ops/repository";
import { isDispatchEligible, isStaleLeaseTakeoverEligible } from "@/lib/core/runtime";

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
  const staleHeartbeatSeconds = Math.min(
    1800,
    Math.max(30, Number(process.env.TASK_STALE_HEARTBEAT_SECONDS ?? "120")),
  );
  const dispatchCooldownSeconds = Math.min(
    600,
    Math.max(1, Number(process.env.TASK_DISPATCH_COOLDOWN_SECONDS ?? "45")),
  );
  const limit = Math.min(25, Math.max(1, Number(process.env.BACKGROUND_DISPATCH_LIMIT ?? "12")));
  const { data: candidates, error } = await db
    .from("tasks")
    .select("id,organization_id,status,run_after,lease_until,last_heartbeat_at,last_dispatched_at,execution_mode")
    .in("status", ["queued", "running"])
    .eq("execution_mode", "background")
    .or(`run_after.is.null,run_after.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(limit * 4);
  if (error) throw new Error(error.message);

  const staleLeaseTakeoverSeconds = Math.min(
    1800,
    Math.max(300, Number(process.env.TASK_STALE_LEASE_TAKEOVER_SECONDS ?? "300")),
  );
  const eligible = (candidates ?? [])
    .filter((task) => {
      const snapshot = {
        status: task.status,
        run_after: task.run_after,
        lease_until: task.lease_until,
        last_heartbeat_at: task.last_heartbeat_at,
        last_dispatched_at: task.last_dispatched_at,
      };
      return (
        isDispatchEligible(
          snapshot,
          now.getTime(),
          staleHeartbeatSeconds * 1000,
          dispatchCooldownSeconds * 1000,
        ) ||
        isStaleLeaseTakeoverEligible(
          snapshot,
          now.getTime(),
          staleLeaseTakeoverSeconds * 1000,
        )
      );
    })
    .slice(0, limit);

  const dispatched: Array<{ taskId: string; dispatchId: string }> = [];
  for (const task of eligible) {
    if (task.status === "running" && task.lease_until && Date.parse(task.lease_until) > now.getTime()) {
      const recovered = await recoverStaleTaskLease(task.id, task.organization_id);
      if (!recovered) continue;
    }

    const dispatchId = newDispatchId(task.id);
    const db = createAdminClient();
    const { data: reservation, error: reservationError } = await db.rpc("reserve_task_dispatch", {
      p_task_id: task.id,
      p_organization_id: task.organization_id,
      p_dispatch_id: dispatchId,
      p_dispatch_cooldown_seconds: dispatchCooldownSeconds,
      p_stale_heartbeat_seconds: staleHeartbeatSeconds,
    });
    if (reservationError) throw new Error(reservationError.message);
    if (!reservation) continue;

    try {
      await enqueueTask({
        taskId: task.id,
        organizationId: task.organization_id,
        reason: "cron_redrive",
        runtimeEnv,
        dispatchId,
      });
      await appendEvent(task.id, task.organization_id, "task.dispatched", {
        dispatchId,
        reason: trigger === "cron" ? "cron_redrive" : "manual_redrive",
        queue: "ai-orchestra-tasks-v66",
        repairedStaleRunning: Boolean(reservation.repairedStaleRunning),
      });
      dispatched.push({ taskId: task.id, dispatchId });
    } catch (error) {
      await appendEvent(task.id, task.organization_id, "task.dispatch_failed", {
        dispatchId,
        reason: error instanceof Error ? error.message.slice(0, 240) : "unknown",
      }).catch(() => {});
      throw error;
    }
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
