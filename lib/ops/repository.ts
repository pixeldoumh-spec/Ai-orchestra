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
