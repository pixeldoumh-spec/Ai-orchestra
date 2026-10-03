import { createAdminClient } from "@/lib/supabase/admin";
import { listAgents } from "./registry";
import { getModelAdapter } from "./model";
import { planWorkflow } from "./planner";
import { appendEvent, claimTask, getTask, heartbeatTask, recalculateTaskSpend, replanTask, updateStep, updateTask } from "./repository";
import type { AgentDefinition, ModelAdapter, PersistedStep, PersistedTask } from "./types";
import { invokeTool } from "@/lib/tools/gateway";
import { readyStepIds, selectParallelBatch } from "@/lib/core/workflow";

const MAX_TOOL_REQUESTS_PER_STEP = 8;

export async function processTask(taskId: string, organizationId: string, workerId = `worker_${crypto.randomUUID()}`) {
  const claimed = await claimTask(taskId, organizationId, workerId);
  if (!claimed) return { claimed: false, task: await getTask(taskId, organizationId) };

  const model = getModelAdapter();
  const agents = await listAgents(organizationId);
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const db = createAdminClient();
  const maxBatches = Number(process.env.TASK_MAX_BATCHES ?? process.env.TASK_MAX_STEPS ?? "12");
  const maxReplans = Number(process.env.TASK_MAX_REPLANS ?? "2");
  let iterations = 0;

  try {
    while (iterations++ < maxBatches) {
      await heartbeatTask(taskId, workerId);
      let snapshot = (await getTask(taskId, organizationId)) as PersistedTask & { approvals?: unknown[] };
      if (["verified", "failed", "cancelled", "awaiting_approval"].includes(snapshot.status)) break;

      const ready = readyStepIds(snapshot.steps);
      if (ready.length === 0) {
        const currentSteps = snapshot.steps.filter((step) => step.plan_revision === snapshot.plan_revision);
        const unresolved = currentSteps.some((step) => ["queued", "running"].includes(step.status));
        if (!unresolved) {
          await finalizeTask(snapshot);
        } else {
          const wakeAt = currentSteps
            .map((step) => step.status === "queued" && step.run_after ? Date.parse(step.run_after) : NaN)
            .filter(Number.isFinite)
            .sort((a, b) => a - b)[0];
          if (wakeAt) await updateTask(taskId, { run_after: new Date(wakeAt).toISOString() });
        }
        break;
      }

      const remainingBudget = Math.max(0, Number(snapshot.max_cost_cents) - Number(snapshot.spent_cost_cents));
      const stepBudget = new Map<string, number>();
      for (const stepId of ready) {
        const step = snapshot.steps.find((item) => item.id === stepId);
        stepBudget.set(stepId, agentMap.get(step?.agent_id ?? "")?.budgetCents ?? 0);
      }
      const batch = selectParallelBatch(ready, stepBudget, remainingBudget);
      if (batch.length === 0) {
        const message = `No ready step fits the remaining task budget (${remainingBudget} cents)`;
        await updateTask(taskId, { status: "failed", error: message, completed_at: new Date().toISOString() });
        await appendEvent(taskId, organizationId, "task.budget_exhausted", { remainingBudget });
        break;
      }

      const batchResults = await Promise.all(batch.map(async (stepId) => {
        const step = snapshot.steps.find((item) => item.id === stepId);
        const agent = step ? agentMap.get(step.agent_id) : undefined;
        if (!step || !agent) throw new Error(`Agent for step ${stepId} is not registered`);
        return runStep({
          taskId,
          organizationId,
          goal: snapshot.goal,
          maxCostCents: snapshot.max_cost_cents,
          step,
          agent,
          priorResults: snapshot.steps.filter((x) => x.plan_revision === snapshot.plan_revision && x.status === "verified").map((x) => ({ stepId: stepPlanId(x), result: x.result })),
          model,
        });
      }));

      const spent = await recalculateTaskSpend(taskId);
      if (spent > Number(snapshot.max_cost_cents)) {
        const message = `Task budget exceeded: ${spent} > ${snapshot.max_cost_cents} cents`;
        await updateTask(taskId, { status: "failed", error: message, completed_at: new Date().toISOString() });
        await appendEvent(taskId, organizationId, "task.budget_exceeded", { spent, maxCostCents: snapshot.max_cost_cents });
        break;
      }

      snapshot = (await getTask(taskId, organizationId)) as PersistedTask & { approvals?: unknown[] };
      if (snapshot.status === "awaiting_approval") break;

      const failed = batchResults.find((result) => result.status === "failed");
      if (failed && snapshot.replan_count < maxReplans) {
        const failedStep = snapshot.steps.find((step) => step.id === failed.stepId);
        const agent = failedStep ? agentMap.get(failedStep.agent_id) : undefined;
        const reason = failedStep?.error ?? "Step failed without an error message";
        const replacementPlan = await planWorkflow({
          goal: snapshot.goal,
          agents,
          priorResults: snapshot.steps.filter((x) => x.plan_revision === snapshot.plan_revision && x.status === "verified").map((x) => ({ stepId: stepPlanId(x), result: x.result })),
          failureContext: { stepId: failed.stepId, agentId: agent?.id ?? failedStep?.agent_id ?? "unknown", error: reason },
        });
        await replanTask({ taskId, organizationId, plan: replacementPlan, reason, plannerModel: process.env.AI_PLANNER_MODEL ?? process.env.OPENAI_MODEL ?? null });
        continue;
      }

      if (failed) {
        await updateTask(taskId, { status: "failed", completed_at: new Date().toISOString() });
        await appendEvent(taskId, organizationId, "task.failed", { reason: "Retries and bounded replans exhausted" });
        break;
      }
      if (batchResults.some((result) => result.status === "awaiting_approval")) break;
    }

    const tail = (await getTask(taskId, organizationId)) as PersistedTask;
    if (tail.status === "running" && iterations > maxBatches) {
      const current = tail.steps.filter((step) => step.plan_revision === tail.plan_revision);
      const wakeAt = current
        .map((step) => step.status === "queued" && step.run_after ? Date.parse(step.run_after) : NaN)
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      await updateTask(taskId, { status: "queued", run_after: wakeAt ? new Date(wakeAt).toISOString() : null });
      await appendEvent(taskId, organizationId, "task.yielded", { maxBatches, requeued: true });
    }

    return { claimed: true, task: await getTask(taskId, organizationId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    await appendEvent(taskId, organizationId, "task.worker_error", { message });
    await updateTask(taskId, { status: "failed", error: message, completed_at: new Date().toISOString(), lease_owner: null, lease_until: null });
    return { claimed: true, task: await getTask(taskId, organizationId) };
  } finally {
    await db.from("tasks").update({ lease_owner: null, lease_until: null }).eq("id", taskId).eq("lease_owner", workerId);
  }
}

async function runStep(input: {
  taskId: string;
  organizationId: string;
  goal: string;
  maxCostCents: number;
  step: PersistedStep;
  agent: AgentDefinition;
  priorResults: unknown[];
  model: ModelAdapter;
}): Promise<{ stepId: string; status: "verified" | "failed" | "awaiting_approval" | "queued"; usageCents: number }> {
  const { taskId, organizationId, goal, maxCostCents, step, agent, priorResults, model } = input;
  const attempt = step.attempt_count + 1;
  await updateStep(step.id, { status: "running", attempt_count: attempt, started_at: new Date().toISOString(), error: null });
  await appendEvent(taskId, organizationId, "step.started", { stepId: step.id, agentId: agent.id, attempt, kind: step.kind });

  try {
    const availableTools = agent.tools.map((id) => ({ id, permission: "declared", approved: true }));
    const targets = (step.verifies ?? [])
      .map((targetId) => input.priorResults.find((result) => result && typeof result === "object" && (result as { stepId?: unknown }).stepId === targetId))
      .filter(Boolean);
    const prompt = [
      `Goal: ${goal}`,
      `Objective: ${step.objective}`,
      `Step kind: ${step.kind}`,
      `Prior verified results: ${JSON.stringify(priorResults).slice(0, 24000)}`,
      step.kind === "verification" ? `Verification targets: ${JSON.stringify(targets).slice(0, 16000)}` : "",
      `Available tools: ${JSON.stringify(availableTools)}`,
      step.kind === "verification"
        ? "Return JSON only: {\"passed\":boolean,\"confidence\":number,\"findings\":string[],\"evidence\":string[]}. Do not mark passed when material requirements are unsupported."
        : "Return JSON when requesting tools: {\"result\":unknown,\"toolRequests\":[{\"toolId\":string,\"input\":unknown}]}. Otherwise return a useful result. Never claim an external action happened unless a tool invocation confirms it.",
    ].filter(Boolean).join("\n\n");

    const result = await model.complete({
      model: agent.model,
      system: `You are ${agent.name}. Capabilities: ${agent.capabilities.join(", ")}. Your output is a proposal for the orchestrator, not proof of execution.`,
      user: prompt,
    });

    await recordUsage(step.id, result.usageCents);

    if (result.usageCents > agent.budgetCents) throw new Error(`Agent budget exceeded: ${result.usageCents} > ${agent.budgetCents} cents`);
    if (result.usageCents > maxCostCents) throw new Error(`Single step exceeds task budget: ${result.usageCents} > ${maxCostCents} cents`);

    const envelope = parseAgentEnvelope(result.output);
    if (envelope.toolRequests.length > MAX_TOOL_REQUESTS_PER_STEP) throw new Error(`Tool request limit exceeded: ${MAX_TOOL_REQUESTS_PER_STEP}`);
    for (const toolRequest of envelope.toolRequests) {
      const tool = await invokeTool(agent, taskId, { toolId: toolRequest.toolId, input: toolRequest.input }, step.id);
      if (tool.approved === false) {
        await updateStep(step.id, { status: "awaiting_approval", result: envelope.result, usage_cents: result.usageCents, finished_at: null });
        await createApproval(taskId, organizationId, step.id, agent.id, tool.approvalReason ?? "Approval required", tool.connectorRequestId ?? null);
        await updateTask(taskId, { status: "awaiting_approval" });
        await appendEvent(taskId, organizationId, "approval.requested", { stepId: step.id, toolId: toolRequest.toolId, reason: tool.approvalReason });
        return { stepId: step.id, status: "awaiting_approval", usageCents: result.usageCents };
      }
    }

    let storedResult = envelope.result;
    if (step.kind === "verification") {
      const verification = parseVerificationResult(envelope.result);
      if (!verification.passed) throw new Error(`Verifier rejected the result: ${verification.findings.join("; ") || "verification failed"}`);
      storedResult = verification;
    }

    await updateStep(step.id, {
      status: "verified",
      result: storedResult,
      checkpoint: { completedAt: new Date().toISOString(), usageCents: result.usageCents, attempt },
      usage_cents: result.usageCents,
      finished_at: new Date().toISOString(),
    });
    await appendEvent(taskId, organizationId, "step.verified", { stepId: step.id, agentId: agent.id, usageCents: result.usageCents, kind: step.kind });
    return { stepId: step.id, status: "verified", usageCents: result.usageCents };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown step error";
    if (attempt < step.max_attempts) {
      const delay = Math.min(60_000, 2 ** (attempt - 1) * 1_000);
      await updateStep(step.id, { status: "queued", error: message, run_after: new Date(Date.now() + delay).toISOString(), usage_cents: step.usage_cents + 0 });
      await appendEvent(taskId, organizationId, "step.retry_scheduled", { stepId: step.id, error: message, delayMs: delay, attempt });
      return { stepId: step.id, status: "queued", usageCents: 0 };
    }
    await updateStep(step.id, { status: "failed", error: message, finished_at: new Date().toISOString() });
    await updateTask(taskId, { status: "running", error: `Step ${step.agent_id} failed: ${message}` });
    await appendEvent(taskId, organizationId, "step.failed", { stepId: step.id, error: message, attempt });
    return { stepId: step.id, status: "failed", usageCents: 0 };
  }
}

function parseAgentEnvelope(output: unknown): { result: unknown; toolRequests: Array<{ toolId: string; input: unknown }> } {
  if (output && typeof output === "object") {
    const candidate = output as { result?: unknown; toolRequests?: unknown };
    if ("result" in candidate || Array.isArray(candidate.toolRequests)) {
      return { result: candidate.result ?? output, toolRequests: normalizeToolRequests(candidate.toolRequests) };
    }
  }
  if (typeof output === "string") {
    try {
      return parseAgentEnvelope(JSON.parse(output));
    } catch {}
  }
  return { result: output, toolRequests: [] };
}

function normalizeToolRequests(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const toolId = (item as { toolId?: unknown }).toolId;
    if (typeof toolId !== "string" || !/^[a-z][a-z0-9._-]{1,80}$/.test(toolId)) return [];
    return [{ toolId, input: (item as { input?: unknown }).input ?? null }];
  });
}

function parseVerificationResult(value: unknown): { passed: boolean; confidence: number; findings: string[]; evidence: string[] } {
  let candidate = value;
  if (typeof value === "string") {
    try { candidate = JSON.parse(value); } catch { throw new Error("Verifier output is not valid JSON"); }
  }
  if (!candidate || typeof candidate !== "object") throw new Error("Verifier output must be a JSON object");
  const v = candidate as { passed?: unknown; confidence?: unknown; findings?: unknown; evidence?: unknown };
  const passed = v.passed === true;
  const confidence = Number(v.confidence ?? 0);
  const findings = Array.isArray(v.findings) ? v.findings.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  const evidence = Array.isArray(v.evidence) ? v.evidence.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Verifier confidence must be between 0 and 1");
  if (!passed && findings.length === 0) findings.push("Verifier did not establish a passing result");
  return { passed, confidence, findings, evidence };
}

async function recordUsage(stepId: string, usageCents: number) {
  const db = createAdminClient();
  const { data, error } = await db.from("task_steps").select("usage_cents_total").eq("id", stepId).single();
  if (error) throw new Error(error.message);
  await updateStep(stepId, { usage_cents: usageCents, usage_cents_total: Number(data?.usage_cents_total ?? 0) + usageCents });
}

async function createApproval(taskId: string, organizationId: string, stepId: string, agentId: string, reason: string, connectorRequestId?: string | null) {
  const db = createAdminClient();
  const expiresAt = new Date(Date.now() + Number(process.env.APPROVAL_TTL_SECONDS ?? "1800") * 1000).toISOString();
  const { error } = await db.from("approvals").insert({ task_id: taskId, organization_id: organizationId, step_id: stepId, requested_by_agent_id: agentId, status: "pending", reason, action_type: "tool.use", connector_request_id: connectorRequestId ?? null, expires_at: expiresAt });
  if (error) throw new Error(error.message);
}

function stepPlanId(step: PersistedStep): string {
  if (step.checkpoint && typeof step.checkpoint === "object") {
    const planStepId = (step.checkpoint as { planStepId?: unknown }).planStepId;
    if (typeof planStepId === "string") return planStepId;
  }
  return step.id;
}

async function finalizeTask(task: PersistedTask) {
  const current = task.steps.filter((step) => step.plan_revision === task.plan_revision);
  const verifier = [...current].reverse().find((step) => step.kind === "verification" && step.status === "verified");
  if (!verifier) throw new Error("Cannot finalize without a verified verifier step");
  const targetResults = (verifier.verifies ?? []).map((id) => current.find((step) => stepPlanId(step) === id)?.result ?? null);
  const finalResult = {
    result: targetResults.length === 1 ? targetResults[0] : targetResults,
    verification: verifier.result,
    planRevision: task.plan_revision,
  };
  await updateTask(task.id, { status: "verified", final_result: finalResult, completed_at: new Date().toISOString(), lease_owner: null, lease_until: null });
  await appendEvent(task.id, task.organization_id, "task.verified", { planRevision: task.plan_revision });
}