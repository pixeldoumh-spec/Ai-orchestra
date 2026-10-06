import { createAdminClient } from "@/lib/supabase/admin";
import { appendEvent, claimTask, recoverStaleTaskLease, settleTaskLease } from "./repository";
import { enqueueTask, newDispatchId } from "./queue";
import {
  claimBackgroundDeadLetterReplay,
  claimBackgroundDelivery,
  finishBackgroundDelivery,
  finishBackgroundWorkerRun,
  markBackgroundDeadLetterReplayed,
  startBackgroundWorkerRun,
  sweepRuntimeIntegrity,
} from "@/lib/ops/repository";
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
  const delivery = await claimBackgroundDelivery({
    dispatchId: input.dispatchId,
    queueMessageId: input.queueMessageId,
    taskId: input.taskId,
    organizationId: input.organizationId,
    attempt: input.attempt,
    workerId,
  });

  if (!delivery?.claimed) {
    await appendEvent(input.taskId, input.organizationId, "task.delivery_duplicate_suppressed", {
      dispatchId: input.dispatchId,
      queueMessageId: input.queueMessageId,
      attempt: input.attempt,
      reason: delivery?.reason ?? "duplicate_delivery",
    }).catch(() => {});
    return {
      claimed: false,
      duplicateDelivery: true,
      reason: delivery?.reason ?? "duplicate_delivery",
    };
  }

  let run: Awaited<ReturnType<typeof startBackgroundWorkerRun>> | null = null;
  let deliveryStatus: "completed" | "failed" | "skipped" = "failed";
  let claimedLease: Awaited<ReturnType<typeof claimTask>> | null = null;

  try {
    // The task lease is the execution fence. Do not create a worker-run record
    // until this delivery has actually acquired the task lease.
    claimedLease = await claimTask(input.taskId, input.organizationId, workerId);
    if (!claimedLease) {
      deliveryStatus = "skipped";
      await finishBackgroundDelivery({
        dispatchId: input.dispatchId,
        attempt: input.attempt,
        workerId,
        status: deliveryStatus,
        metadata: {
          queueMessageId: input.queueMessageId,
          duplicateDelivery: true,
          reason: "task_execution_already_claimed",
        },
      }).catch(() => {});
      return {
        claimed: false,
        duplicateDelivery: true,
        reason: "task_execution_already_claimed",
      };
    }

    const leaseGeneration = Number(claimedLease.lease_generation ?? 0);
    try {
      run = await startBackgroundWorkerRun({
        organizationId: input.organizationId,
        taskId: input.taskId,
        dispatchId: input.dispatchId,
        workerId,
        trigger: "queue",
        attempt: input.attempt,
      });
    } catch (error) {
      await settleTaskLease(input.taskId, input.organizationId, workerId, leaseGeneration).catch(() => null);
      throw error;
    }

    const startedAt = run.startedAt;
    try {
      const { processTask } = await import("./worker");
      const result = await processTask(
        input.taskId,
        input.organizationId,
        workerId,
        input.runtimeEnv,
        { claimedLease, releaseLease: false },
      );
      const db = createAdminClient();
      const { data: task } = await db
        .from("tasks")
        .select("status")
        .eq("id", input.taskId)
        .eq("organization_id", input.organizationId)
        .maybeSingle();

      deliveryStatus = result.workerError ? "failed" : result.claimed ? "completed" : "skipped";
      await finishBackgroundWorkerRun({
        id: run.id,
        status: deliveryStatus,
        startedAt,
        metadata: {
          dispatchId: input.dispatchId,
          queueMessageId: input.queueMessageId,
          claimed: result.claimed,
          duplicateDelivery: false,
          taskStatus: task?.status ?? null,
        },
      });
      if (result.workerError) {
        throw new Error("Background task execution returned a retryable worker failure");
      }
      return { ...result, duplicateDelivery: false };
    } catch (error) {
      deliveryStatus = "failed";
      if (run) {
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
      }
      throw error;
    }
  } finally {
    if (claimedLease) {
      await settleTaskLease(
        input.taskId,
        input.organizationId,
        workerId,
        Number(claimedLease.lease_generation ?? 0),
      ).catch(() => null);
    }
    await finishBackgroundDelivery({
      dispatchId: input.dispatchId,
      attempt: input.attempt,
      workerId,
      status: deliveryStatus,
      metadata: {
        queueMessageId: input.queueMessageId,
        duplicateDelivery: false,
      },
    }).catch((error) => {
      console.error(JSON.stringify({
        event: "ops.delivery_finish_failed",
        dispatchId: input.dispatchId,
        attempt: input.attempt,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }));
    });
  }
}
export async function replayBackgroundDeadLetter(id: number, runtimeEnv: unknown) {
  hydrateRuntimeEnvironment(runtimeEnv);
  const newDispatchId = `dlq_${id}_${crypto.randomUUID()}`;
  const claim = await claimBackgroundDeadLetterReplay(id, newDispatchId);
  if (!claim) return { replayed: false, reason: "already_replayed_or_inflight" };
  if (!claim.taskId || !claim.organizationId) {
    throw new Error("DLQ entry has no task identity and cannot be replayed");
  }

  await enqueueTask({
    taskId: claim.taskId,
    organizationId: claim.organizationId,
    reason: "dlq_replay",
    runtimeEnv,
    dispatchId: newDispatchId,
  });
  const marked = await markBackgroundDeadLetterReplayed(id, newDispatchId);
  if (!marked) throw new Error("DLQ replay enqueue succeeded but replay finalization was fenced");

  await appendEvent(claim.taskId, claim.organizationId, "task.dlq_replayed", {
    deadLetterId: id,
    originalDispatchId: claim.dispatchId,
    originalQueueMessageId: claim.queueMessageId,
    replayDispatchId: newDispatchId,
    replayCount: "recorded",
  }).catch(() => {});

  return { replayed: true, deadLetterId: id, dispatchId: newDispatchId };
}
