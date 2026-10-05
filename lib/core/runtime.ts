export type RuntimeTaskSnapshot = {
  status: string;
  run_after?: string | null;
  lease_until?: string | null;
  last_heartbeat_at?: string | null;
  last_dispatched_at?: string | null;
};

export function isLeaseActive(task: RuntimeTaskSnapshot, nowMs = Date.now()): boolean {
  const leaseUntil = task.lease_until ? Date.parse(task.lease_until) : NaN;
  return Number.isFinite(leaseUntil) && leaseUntil > nowMs;
}

export function isHeartbeatFresh(
  task: RuntimeTaskSnapshot,
  nowMs = Date.now(),
  staleHeartbeatMs = 120_000,
): boolean {
  const heartbeat = task.last_heartbeat_at ? Date.parse(task.last_heartbeat_at) : NaN;
  return Number.isFinite(heartbeat) && heartbeat > nowMs - staleHeartbeatMs;
}

export function isDispatchCooldownActive(
  task: RuntimeTaskSnapshot,
  nowMs = Date.now(),
  cooldownMs = 45_000,
): boolean {
  const dispatched = task.last_dispatched_at ? Date.parse(task.last_dispatched_at) : NaN;
  return Number.isFinite(dispatched) && dispatched > nowMs - cooldownMs;
}

export function isDispatchEligible(
  task: RuntimeTaskSnapshot,
  nowMs = Date.now(),
  staleHeartbeatMs = 120_000,
  cooldownMs = 45_000,
): boolean {
  if (!["queued", "running"].includes(task.status)) return false;

  const runAfter = task.run_after ? Date.parse(task.run_after) : NaN;
  if (Number.isFinite(runAfter) && runAfter > nowMs) return false;
  if (isDispatchCooldownActive(task, nowMs, cooldownMs)) return false;
  if (isLeaseActive(task, nowMs)) return false;

  if (task.status === "queued") return true;

  return !isHeartbeatFresh(task, nowMs, staleHeartbeatMs);
}

export function safeWorkerExitStatus(task: RuntimeTaskSnapshot): "queued" | "terminal" | "continue" {
  if (["verified", "failed", "cancelled", "awaiting_approval"].includes(task.status)) return "terminal";
  if (task.status === "running") return "queued";
  return "continue";
}


export function stepNeedsRecovery(
  executionLeaseGeneration: number | null | undefined,
  currentLeaseGeneration: number,
): boolean {
  return executionLeaseGeneration == null || executionLeaseGeneration !== currentLeaseGeneration;
}


export function isStaleLeaseTakeoverEligible(
  task: RuntimeTaskSnapshot,
  nowMs = Date.now(),
  staleLeaseTakeoverMs = 300_000,
): boolean {
  if (task.status !== "running") return false;
  const leaseUntil = task.lease_until ? Date.parse(task.lease_until) : NaN;
  const heartbeat = task.last_heartbeat_at ? Date.parse(task.last_heartbeat_at) : NaN;
  if (!Number.isFinite(leaseUntil) || leaseUntil <= nowMs) return false;
  if (!Number.isFinite(heartbeat)) return false;
  return heartbeat <= nowMs - staleLeaseTakeoverMs;
}
