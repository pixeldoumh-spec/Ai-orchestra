import { createAdminClient } from "@/lib/supabase/admin";
import { randomId } from "@/lib/core/security";
import { buildDefaultPlan } from "@/lib/core/workflow";

export async function createTask(input: {
  organizationId: string;
  userId: string;
  goal: string;
  idempotencyKey: string;
  maxCostCents: number;
}) {
  const db = createAdminClient();
  const taskId = randomId("task");
  const plan = buildDefaultPlan(input.goal);
  const { data, error } = await db.from("tasks").insert({
    id: taskId,
    organization_id: input.organizationId,
    created_by: input.userId,
    goal: input.goal,
    status: "queued",
    idempotency_key: input.idempotencyKey,
    max_cost_cents: input.maxCostCents,
    spent_cost_cents: 0,
    plan_version: "v2-deterministic-1",
  }).select("*").single();

  if (error) {
    if (error.code === "23505") {
      const { data: existing, error: existingError } = await db.from("tasks").select("*").eq("organization_id", input.organizationId).eq("idempotency_key", input.idempotencyKey).single();
      if (existingError) throw new Error(existingError.message);
      return existing;
    }
    throw new Error(error.message);
  }

  const steps = plan.map((step, index) => ({
    id: `${taskId}_step_${index + 1}`,
    task_id: taskId,
    agent_id: step.agentId,
    objective: step.objective,
    status: "queued",
    depends_on: step.dependsOn.map((id) => `${taskId}_step_${plan.findIndex((item) => item.id === id) + 1}`),
    max_attempts: step.maxAttempts,
    attempt_count: 0,
  }));
  const { error: stepError } = await db.from("task_steps").insert(steps);
  if (stepError) {
    await db.from("tasks").delete().eq("id", taskId);
    throw new Error(stepError.message);
  }
  await appendEvent(taskId, input.organizationId, "task.queued", { goal: input.goal });
  return data;
}

export async function getTask(taskId: string, organizationId: string) {
  const db = createAdminClient();
  const { data: task, error } = await db.from("tasks").select("*").eq("id", taskId).eq("organization_id", organizationId).single();
  if (error) throw new Error(error.message);
  const { data: steps, error: stepError } = await db.from("task_steps").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
  if (stepError) throw new Error(stepError.message);
  const { data: events, error: eventError } = await db.from("task_events").select("*").eq("task_id", taskId).order("created_at", { ascending: true }).limit(200);
  if (eventError) throw new Error(eventError.message);
  const { data: artifacts } = await db.from("task_artifacts").select("id, name, content, created_at").eq("task_id", taskId).order("created_at", { ascending: true });
  return { ...task, steps: steps ?? [], events: events ?? [], artifacts: artifacts ?? [] };
}

export async function appendEvent(taskId: string, organizationId: string, eventType: string, payload: unknown) {
  const db = createAdminClient();
  const { error } = await db.from("task_events").insert({ task_id: taskId, organization_id: organizationId, event_type: eventType, actor_type: "system", payload });
  if (error) throw new Error(error.message);
}

export async function claimTask(taskId: string, organizationId: string, workerId: string) {
  const db = createAdminClient();
  const leaseSeconds = Number(process.env.TASK_LEASE_SECONDS ?? "600");
  const until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const { data, error } = await db.from("tasks")
    .update({ status: "running", lease_owner: workerId, lease_until: until, started_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("organization_id", organizationId)
    .in("status", ["queued", "running"])
    .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`)
    .select("*").single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw new Error(error.message);
  }
  await appendEvent(taskId, organizationId, "task.claimed", { workerId, leaseUntil: until });
  return data;
}

export async function heartbeatTask(taskId: string, workerId: string) {
  const db = createAdminClient();
  const leaseSeconds = Number(process.env.TASK_LEASE_SECONDS ?? "600");
  const { error } = await db.from("tasks").update({ lease_until: new Date(Date.now() + leaseSeconds * 1000).toISOString() }).eq("id", taskId).eq("lease_owner", workerId);
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
