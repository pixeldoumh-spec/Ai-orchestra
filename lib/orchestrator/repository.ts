import { createAdminClient } from "@/lib/supabase/admin";
import { randomId } from "@/lib/core/security";
import type { WorkflowPlan } from "@/lib/core/workflow";

function materializeSteps(taskId: string, plan: WorkflowPlan, revision: number) {
  const idMap = new Map(plan.steps.map((step, index) => [step.id, `${taskId}_step_r${revision}_${index + 1}`]));
  return plan.steps.map((step, index) => ({
    id: idMap.get(step.id)!,
    task_id: taskId,
    agent_id: step.agentId,
    objective: step.objective,
    status: "queued",
    depends_on: step.dependsOn.map((id) => idMap.get(id)!),
    max_attempts: step.maxAttempts,
    attempt_count: 0,
    kind: step.kind,
    verifies: step.verifies ?? [],
    plan_revision: revision,
    usage_cents: 0,
    usage_cents_total: 0,
    checkpoint: { planStepId: step.id, planRevision: revision, ordinal: index + 1 },
  }));
}

export async function createTask(input: {
  organizationId: string;
  userId: string;
  goal: string;
  idempotencyKey: string;
  maxCostCents: number;
  plan: WorkflowPlan;
  plannerModel?: string | null;
  teamId?: string | null;
}) {
  const db = createAdminClient();
  const taskId = randomId("task");
  const { data, error } = await db.from("tasks").insert({
    id: taskId,
    organization_id: input.organizationId,
    created_by: input.userId,
    goal: input.goal,
    status: "queued",
    idempotency_key: input.idempotencyKey,
    max_cost_cents: input.maxCostCents,
    spent_cost_cents: 0,
    plan_version: "v5.0.0",
    plan_revision: 1,
    replan_count: 0,
    planner_model: input.plannerModel ?? null,
    plan_json: input.plan,
    execution_mode: "background",
  }).select("*").single();

  if (error) {
    if (error.code === "23505") {
      const { data: existing, error: existingError } = await db.from("tasks").select("*").eq("organization_id", input.organizationId).eq("idempotency_key", input.idempotencyKey).single();
      if (existingError) throw new Error(existingError.message);
      return existing;
    }
    throw new Error(error.message);
  }

  const { error: stepError } = await db.from("task_steps").insert(materializeSteps(taskId, input.plan, 1));
  if (stepError) {
    await db.from("tasks").delete().eq("id", taskId);
    throw new Error(stepError.message);
  }
  await appendEvent(taskId, input.organizationId, "task.queued", { goal: input.goal, planVersion: "v6.6.0", stepCount: input.plan.steps.length, executionMode: "background" });
  await appendEvent(taskId, input.organizationId, "plan.created", { planVersion: "v4.0.0", revision: 1, rationale: input.plan.rationale ?? null });
  return data;
}

export async function getTask(taskId: string, organizationId: string) {
  const db = createAdminClient();
  const { data: task, error } = await db.from("tasks").select("*").eq("id", taskId).eq("organization_id", organizationId).single();
  if (error) throw new Error(error.message);
  const { data: steps, error: stepError } = await db.from("task_steps").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
  if (stepError) throw new Error(stepError.message);
  const { data: events, error: eventError } = await db.from("task_events").select("*").eq("task_id", taskId).order("id", { ascending: true }).limit(400);
  if (eventError) throw new Error(eventError.message);
  const { data: artifacts } = await db.from("task_artifacts").select("id, name, content, created_at").eq("task_id", taskId).order("created_at", { ascending: true });
  const { data: approvals } = await db.from("approvals").select("id, step_id, status, action_type, reason, resolved_by, resolved_at, created_at, expires_at, connector_request_id").eq("task_id", taskId).order("created_at", { ascending: true });
  const { data: toolInvocations } = await db.from("tool_invocations").select("id, step_id, agent_id, tool_id, status, connector_request_id, policy_decision, created_at, completed_at").eq("task_id", taskId).order("created_at", { ascending: true }).limit(200);
  return { ...task, steps: steps ?? [], events: events ?? [], artifacts: artifacts ?? [], approvals: approvals ?? [], toolInvocations: toolInvocations ?? [] };
}

export async function listTasks(organizationId: string, limit = 50) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("tasks")
    .select("id, organization_id, created_by, goal, status, max_cost_cents, spent_cost_cents, plan_version, plan_revision, replan_count, execution_mode, execution_region, planner_model, started_at, completed_at, created_at, updated_at, error")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(Math.min(100, Math.max(1, limit)));
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function appendEvent(taskId: string, organizationId: string, eventType: string, payload: unknown, actorId?: string) {
  const db = createAdminClient();
  const { error } = await db.from("task_events").insert({ task_id: taskId, organization_id: organizationId, event_type: eventType, actor_type: actorId ? "user" : "system", actor_id: actorId ?? null, payload });
  if (error) throw new Error(error.message);
}

export class TaskLeaseLostError extends Error {
  constructor(message = "Task lease lost") {
    super(message);
    this.name = "TaskLeaseLostError";
  }
}

export async function claimTask(taskId: string, organizationId: string, workerId: string) {
  const db = createAdminClient();
  const leaseSeconds = Number(process.env.TASK_LEASE_SECONDS ?? "600");
  const staleHeartbeatSeconds = Number(process.env.TASK_STALE_HEARTBEAT_SECONDS ?? "120");
  const { data, error } = await db.rpc("claim_task_lease", {
    p_task_id: taskId,
    p_organization_id: organizationId,
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
    p_stale_heartbeat_seconds: staleHeartbeatSeconds,
  });
  if (error) throw new Error(error.message);
  if (!data) return null;
  await appendEvent(taskId, organizationId, "task.claimed", {
    workerId,
    leaseUntil: data.leaseUntil ?? null,
    leaseGeneration: Number(data.leaseGeneration ?? 0),
  });
  return {
    lease_generation: Number(data.leaseGeneration ?? 0),
    lease_owner: data.leaseOwner ?? workerId,
    lease_until: data.leaseUntil ?? null,
    status: "running",
  };
}

export async function heartbeatTask(
  taskId: string,
  organizationId: string,
  workerId: string,
  leaseGeneration: number,
) {
  const db = createAdminClient();
  const leaseSeconds = Number(process.env.TASK_LEASE_SECONDS ?? "600");
  const { error } = await db.rpc("heartbeat_task_lease", {
    p_task_id: taskId,
    p_organization_id: organizationId,
    p_worker_id: workerId,
    p_lease_generation: leaseGeneration,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    if (/lease lost/i.test(error.message)) throw new TaskLeaseLostError();
    throw new Error(error.message);
  }
}

export async function settleTaskLease(
  taskId: string,
  organizationId: string,
  workerId: string,
  leaseGeneration: number,
) {
  const db = createAdminClient();
  const delay = Number(process.env.TASK_REQUEUE_DELAY_SECONDS ?? "1");
  const { data, error } = await db.rpc("settle_task_lease", {
    p_task_id: taskId,
    p_organization_id: organizationId,
    p_worker_id: workerId,
    p_lease_generation: leaseGeneration,
    p_requeue_delay_seconds: delay,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function updateTaskOwned(
  taskId: string,
  organizationId: string,
  workerId: string,
  leaseGeneration: number,
  patch: Record<string, unknown>,
) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("tasks")
    .update(patch)
    .eq("id", taskId)
    .eq("organization_id", organizationId)
    .eq("status", "running")
    .eq("lease_owner", workerId)
    .eq("lease_generation", leaseGeneration)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new TaskLeaseLostError();
}

export async function updateStepOwned(
  stepId: string,
  taskId: string,
  organizationId: string,
  workerId: string,
  leaseGeneration: number,
  patch: Record<string, unknown>,
) {
  const db = createAdminClient();
  const { data: owner, error: ownerError } = await db
    .from("tasks")
    .select("id")
    .eq("id", taskId)
    .eq("organization_id", organizationId)
    .eq("status", "running")
    .eq("lease_owner", workerId)
    .eq("lease_generation", leaseGeneration)
    .maybeSingle();
  if (ownerError) throw new Error(ownerError.message);
  if (!owner) throw new TaskLeaseLostError();

  const { error } = await db.from("task_steps").update(patch).eq("id", stepId).eq("task_id", taskId);
  if (error) throw new Error(error.message);
}

export async function updateStep(stepId: string, patch: Record<string, unknown>) {
  const db = createAdminClient();
  const { error } = await db.from("task_steps").update(patch).eq("id", stepId);
  if (error) throw new Error(error.message);
}

export async function updateTask(taskId: string, patch: Record<string, unknown>) {
  const db = createAdminClient();
  const { error } = await db.from("tasks").update(patch).eq("id", taskId);
  if (error) throw new Error(error.message);
}

export async function recalculateTaskSpend(
  taskId: string,
  organizationId?: string,
  workerId?: string,
  leaseGeneration?: number,
): Promise<number> {
  const db = createAdminClient();
  const { data, error } = await db.from("task_steps").select("usage_cents_total").eq("task_id", taskId);
  if (error) throw new Error(error.message);
  const spent = (data ?? []).reduce((sum, step) => sum + Number(step.usage_cents_total ?? 0), 0);
  if (organizationId && workerId && leaseGeneration != null) {
    await updateTaskOwned(taskId, organizationId, workerId, leaseGeneration, { spent_cost_cents: spent });
  } else {
    await updateTask(taskId, { spent_cost_cents: spent });
  }
  return spent;
}

export async function replanTask(input: { taskId: string; organizationId: string; plan: WorkflowPlan; reason: string; plannerModel?: string | null }) {
  const db = createAdminClient();
  const { data: task, error: taskError } = await db.from("tasks").select("plan_revision, replan_count").eq("id", input.taskId).eq("organization_id", input.organizationId).single();
  if (taskError) throw new Error(taskError.message);

  const revision = Number(task.plan_revision ?? 1) + 1;
  const newSteps = materializeSteps(input.taskId, input.plan, revision);
  const { error: insertError } = await db.from("task_steps").insert(newSteps);
  if (insertError) throw new Error(insertError.message);

  const { error: cancelError } = await db.from("task_steps").update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("task_id", input.taskId)
    .eq("plan_revision", Number(task.plan_revision ?? 1))
    .eq("status", "queued");
  if (cancelError) throw new Error(cancelError.message);

  const nextCount = Number(task.replan_count ?? 0) + 1;
  const { error: updateError } = await db.from("tasks").update({
    status: "queued",
    plan_version: `v4.${revision}`,
    plan_revision: revision,
    replan_count: nextCount,
    planner_model: input.plannerModel ?? null,
    plan_json: input.plan,
    run_after: null,
    error: null,
  }).eq("id", input.taskId).eq("organization_id", input.organizationId);
  if (updateError) throw new Error(updateError.message);

  await appendEvent(input.taskId, input.organizationId, "task.replanned", {
    revision,
    replanCount: nextCount,
    reason: input.reason,
    stepCount: input.plan.steps.length,
    rationale: input.plan.rationale ?? null,
  });
  return { revision, replanCount: nextCount };
}