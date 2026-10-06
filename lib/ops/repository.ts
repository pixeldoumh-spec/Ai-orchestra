import { createAdminClient } from "@/lib/supabase/admin";

export type ExecutionMetricInput = {
  organizationId: string;
  taskId: string;
  stepId?: string | null;
  agentId?: string | null;
  provider: string;
  model?: string | null;
  attempt: number;
  turn: number;
  status: "completed" | "failed";
  startedAt: string;
  completedAt?: string | null;
  latencyMs?: number | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  usageCents?: number;
  resourceUnit?: string | null;
  resourceQuantity?: number | null;
  fallbackFromProvider?: string | null;
  fallbackFromModel?: string | null;
  errorClass?: string | null;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordExecutionMetric(input: ExecutionMetricInput) {
  const db = createAdminClient();
  const { error } = await db.from("task_execution_metrics").insert({
    organization_id: input.organizationId,
    task_id: input.taskId,
    step_id: input.stepId ?? null,
    agent_id: input.agentId ?? null,
    provider: input.provider.slice(0, 80),
    model: input.model ? input.model.slice(0, 160) : null,
    attempt: Math.max(1, Math.floor(input.attempt)),
    turn: Math.max(1, Math.floor(input.turn)),
    status: input.status,
    started_at: input.startedAt,
    completed_at: input.completedAt ?? null,
    latency_ms: input.latencyMs == null ? null : Math.max(0, Math.floor(input.latencyMs)),
    input_tokens: Math.max(0, Math.floor(input.inputTokens ?? 0)),
    cached_input_tokens: Math.max(0, Math.floor(input.cachedInputTokens ?? 0)),
    output_tokens: Math.max(0, Math.floor(input.outputTokens ?? 0)),
    usage_cents: Math.max(0, Math.floor(input.usageCents ?? 0)),
    resource_unit: input.resourceUnit ?? null,
    resource_quantity: input.resourceQuantity == null ? null : Number(Math.max(0, Number(input.resourceQuantity)).toFixed(4)),
    fallback_from_provider: input.fallbackFromProvider ?? null,
    fallback_from_model: input.fallbackFromModel ?? null,
    error_class: input.errorClass?.slice(0, 120) ?? null,
    error_code: input.errorCode?.slice(0, 80) ?? null,
    metadata: JSON.parse(JSON.stringify(input.metadata ?? {})),
  });
  if (error) throw new Error(error.message);
}

export async function startBackgroundWorkerRun(input: {
  organizationId: string;
  taskId?: string | null;
  dispatchId: string;
  workerId: string;
  trigger: "queue" | "cron" | "manual";
  attempt?: number;
}) {
  const db = createAdminClient();
  const { data, error } = await db.from("background_worker_runs").insert({
    organization_id: input.organizationId,
    task_id: input.taskId ?? null,
    dispatch_id: input.dispatchId,
    worker_id: input.workerId,
    trigger: input.trigger,
    attempt: Math.max(1, Math.floor(input.attempt ?? 1)),
  }).select("id,started_at").single();
  if (error) throw new Error(error.message);
  return { id: Number(data.id), startedAt: data.started_at as string };
}

export async function finishBackgroundWorkerRun(input: {
  id: number;
  status: "completed" | "failed" | "skipped";
  startedAt: string;
  errorClass?: string | null;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const db = createAdminClient();
  const now = new Date().toISOString();
  const { error } = await db.from("background_worker_runs").update({
    status: input.status,
    completed_at: now,
    latency_ms: Math.max(0, Date.parse(now) - Date.parse(input.startedAt)),
    error_class: input.errorClass?.slice(0, 120) ?? null,
    error_code: input.errorCode?.slice(0, 80) ?? null,
    metadata: JSON.parse(JSON.stringify(input.metadata ?? {})),
  }).eq("id", input.id);
  if (error) throw new Error(error.message);
}

export async function markTaskDispatched(taskId: string, dispatchId: string) {
  const db = createAdminClient();
  const { data, error } = await db.rpc("mark_task_dispatched", {
    p_task_id: taskId,
    p_dispatch_id: dispatchId,
  });
  if (error) throw new Error(error.message);
  return data as { task_id: string; dispatch_count: number; last_dispatched_at: string; last_dispatch_id: string } | null;
}

export async function getOperationsDashboard(organizationId: string, days = 30) {
  const db = createAdminClient();
  const since = new Date(Date.now() - Math.max(1, Math.min(90, days)) * 86400000).toISOString();
  const { data, error } = await db.rpc("get_operations_dashboard", {
    p_organization_id: organizationId,
    p_since: since,
  });
  if (error) throw new Error(error.message);
  return data ?? { summary: {}, tasks: {}, workers: {}, daily: [], models: [] };
}


export async function claimBackgroundDelivery(input: {
  dispatchId: string;
  queueMessageId: string;
  taskId: string;
  organizationId: string;
  attempt: number;
  workerId: string;
  staleSeconds?: number;
}) {
  const db = createAdminClient();
  const { data, error } = await db.rpc("claim_background_delivery", {
    p_dispatch_id: input.dispatchId,
    p_queue_message_id: input.queueMessageId,
    p_task_id: input.taskId,
    p_organization_id: input.organizationId,
    p_attempt: Math.max(1, Math.floor(input.attempt)),
    p_worker_id: input.workerId,
    p_stale_seconds: Math.max(30, Math.floor(input.staleSeconds ?? 900)),
  });
  if (error) throw new Error(error.message);
  return data as { claimed: boolean; reason?: string; deliveryId?: number; reclaimed?: boolean } | null;
}

export async function finishBackgroundDelivery(input: {
  dispatchId: string;
  attempt: number;
  workerId: string;
  status: "completed" | "failed" | "skipped";
  metadata?: Record<string, unknown>;
}) {
  const db = createAdminClient();
  const { data, error } = await db.rpc("finish_background_delivery", {
    p_dispatch_id: input.dispatchId,
    p_attempt: Math.max(1, Math.floor(input.attempt)),
    p_worker_id: input.workerId,
    p_status: input.status,
    p_metadata: input.metadata ?? {},
  });
  if (error) throw new Error(error.message);
  return data as { updated: boolean; reason?: string; status?: string } | null;
}

export async function sweepRuntimeIntegrity(input?: {
  staleLeaseSeconds?: number;
  staleWorkerRunSeconds?: number;
  maxTasks?: number;
}) {
  const db = createAdminClient();
  const { data, error } = await db.rpc("sweep_runtime_integrity", {
    p_stale_lease_seconds: Math.max(30, Math.floor(input?.staleLeaseSeconds ?? 300)),
    p_stale_worker_run_seconds: Math.max(30, Math.floor(input?.staleWorkerRunSeconds ?? 900)),
    p_max_tasks: Math.max(1, Math.floor(input?.maxTasks ?? 25)),
  });
  if (error) throw new Error(error.message);
  return data as {
    recoveredTaskIds?: string[];
    recoveredCount?: number;
    closedWorkerRuns?: number;
    sweptAt?: string;
  };
}

export async function listBackgroundDeadLetters(limit = 50) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("background_dead_letters")
    .select("id,organization_id,task_id,dispatch_id,queue_message_id,attempts,reason,payload_hash,metadata,created_at,replay_claimed_at,replay_dispatch_id,replay_count,replayed_at")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(100, Math.floor(limit))));
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function claimBackgroundDeadLetterReplay(id: number, newDispatchId: string, staleSeconds = 600) {
  const db = createAdminClient();
  const { data, error } = await db.rpc("claim_background_dead_letter_replay", {
    p_id: id,
    p_new_dispatch_id: newDispatchId,
    p_stale_seconds: Math.max(30, Math.floor(staleSeconds)),
  });
  if (error) throw new Error(error.message);
  return data as {
    id: number;
    organizationId: string | null;
    taskId: string | null;
    dispatchId: string | null;
    queueMessageId: string;
    attempts: number;
    reason: string;
    newDispatchId: string;
  } | null;
}

export async function markBackgroundDeadLetterReplayed(id: number, dispatchId: string) {
  const db = createAdminClient();
  const { data, error } = await db.rpc("mark_background_dead_letter_replayed", {
    p_id: id,
    p_dispatch_id: dispatchId,
  });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

export async function recordBackgroundDeadLetter(input: {
  organizationId?: string | null;
  taskId?: string | null;
  dispatchId?: string | null;
  queueMessageId: string;
  attempts: number;
  reason: string;
  metadata?: Record<string, unknown>;
}) {
  const db = createAdminClient();
  const body = JSON.stringify({
    organizationId: input.organizationId ?? null,
    taskId: input.taskId ?? null,
    dispatchId: input.dispatchId ?? null,
    queueMessageId: input.queueMessageId,
    attempts: Math.max(1, Math.floor(input.attempts)),
    metadata: input.metadata ?? {},
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const payloadHash = Array.from(new Uint8Array(digest)).map((v) => v.toString(16).padStart(2, "0")).join("");
  const { data, error } = await db.rpc("record_background_dead_letter", {
    p_organization_id: input.organizationId ?? null,
    p_task_id: input.taskId ?? null,
    p_dispatch_id: input.dispatchId ?? null,
    p_queue_message_id: input.queueMessageId,
    p_attempts: Math.max(1, Math.floor(input.attempts)),
    p_reason: input.reason.slice(0, 500),
    p_payload_hash: payloadHash,
    p_metadata: input.metadata ?? {},
  });
  if (error) throw new Error(error.message);
  return Number(data);
}
