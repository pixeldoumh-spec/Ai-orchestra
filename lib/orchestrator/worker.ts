import { createAdminClient } from "@/lib/supabase/admin";
import { listAgents } from "./registry";
import { getModelAdapter } from "./model";
import { appendEvent, claimTask, getTask, heartbeatTask, updateStep, updateTask } from "./repository";
import type { AgentDefinition } from "./types";
import { invokeTool } from "@/lib/tools/gateway";
import { readyStepIds } from "@/lib/core/workflow";

export async function processTask(taskId: string, organizationId: string, workerId = `worker_${crypto.randomUUID()}`) {
  const claimed = await claimTask(taskId, organizationId, workerId);
  if (!claimed) return { claimed: false, task: await getTask(taskId, organizationId) };

  const model = getModelAdapter();
  const agents = await listAgents(organizationId);
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const db = createAdminClient();
  let snapshot = await getTask(taskId, organizationId);
  const maxSteps = Number(process.env.TASK_MAX_STEPS ?? "12");
  let iterations = 0;

  try {
    while (iterations++ < maxSteps) {
      await heartbeatTask(taskId, workerId);
      snapshot = await getTask(taskId, organizationId);
      if (["verified", "failed", "cancelled", "awaiting_approval"].includes(snapshot.status)) break;

      const ready = readyStepIds(snapshot.steps);
      if (ready.length === 0) {
        const unresolved = snapshot.steps.some((step: { status: string }) => ["queued", "running"].includes(step.status));
        if (!unresolved) {
          await finalizeTask(snapshot);
        }
        break;
      }

      for (const stepId of ready) {
        const step = snapshot.steps.find((item: { id: string }) => item.id === stepId);
        if (!step) continue;
        const agent = agentMap.get(step.agent_id);
        if (!agent) throw new Error(`Agent ${step.agent_id} is not registered`);
        await runStep(taskId, organizationId, snapshot.goal, snapshot.max_cost_cents, step, agent, snapshot.steps.filter((x: { status: string }) => x.status === "verified").map((x: { result: unknown }) => x.result), model);
        const afterStep = await getTask(taskId, organizationId);
        if (afterStep.status !== "running") {
          snapshot = afterStep;
          break;
        }
      }
    }

    snapshot = await getTask(taskId, organizationId);
    return { claimed: true, task: snapshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    await appendEvent(taskId, organizationId, "task.worker_error", { message });
    await updateTask(taskId, { status: "failed", error: message, completed_at: new Date().toISOString(), lease_owner: null, lease_until: null });
    return { claimed: true, task: await getTask(taskId, organizationId) };
  } finally {
    await db.from("tasks").update({ lease_owner: null, lease_until: null }).eq("id", taskId).eq("lease_owner", workerId);
  }
}

async function runStep(
  taskId: string,
  organizationId: string,
  goal: string,
  maxCostCents: number,
  step: { id: string; agent_id: string; objective: string; attempt_count: number; max_attempts: number },
  agent: AgentDefinition,
  priorResults: unknown[],
  model: ReturnType<typeof getModelAdapter>,
) {
  await updateStep(step.id, { status: "running", attempt_count: step.attempt_count + 1, started_at: new Date().toISOString(), error: null });
  await appendEvent(taskId, organizationId, "step.started", { stepId: step.id, agentId: agent.id, attempt: step.attempt_count + 1 });

  try {
    const availableTools = agent.tools.map((id) => ({ id, allowed: true }));
    const prompt = [
      `Goal: ${goal}`,
      `Objective: ${step.objective}`,
      `Prior verified results: ${JSON.stringify(priorResults)}`,
      `Available tools: ${JSON.stringify(availableTools)}`,
      "Return a concise, useful result. Do not claim an external action happened unless a tool invocation confirms it.",
    ].join("\n\n");
    const result = await model.complete({
      model: agent.model,
      system: `You are ${agent.name}. Capabilities: ${agent.capabilities.join(", ")}.`,
      user: prompt,
    });

    if (result.usageCents > agent.budgetCents) throw new Error(`Agent budget exceeded: ${result.usageCents} > ${agent.budgetCents} cents`);
    const projectedSpend = await nextSpend(taskId, result.usageCents);
    if (projectedSpend > maxCostCents) throw new Error(`Task budget exceeded: ${projectedSpend} > ${maxCostCents} cents`);

    if (agent.id === "writer" && agent.tools.includes("artifact.write")) {
      const tool = await invokeTool(agent, taskId, { toolId: "artifact.write", input: { name: "result.md", content: result.output } });
      if (tool.approved === false) {
        await updateStep(step.id, { status: "awaiting_approval" });
        await createApproval(taskId, organizationId, step.id, agent.id, tool.approvalReason ?? "Approval required");
        await updateTask(taskId, { status: "awaiting_approval" });
        await appendEvent(taskId, organizationId, "approval.requested", { stepId: step.id, reason: tool.approvalReason });
        return;
      }
    }

    const verified = agent.id !== "verifier" ? true : Boolean(result.output);
    if (!verified) throw new Error("Verifier rejected the result");

    await updateStep(step.id, {
      status: "verified",
      result: result.output,
      checkpoint: { completedAt: new Date().toISOString(), usageCents: result.usageCents },
      usage_cents: result.usageCents,
      finished_at: new Date().toISOString(),
    });
    await updateTask(taskId, { spent_cost_cents: projectedSpend });
    await appendEvent(taskId, organizationId, "step.verified", { stepId: step.id, agentId: agent.id, usageCents: result.usageCents });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown step error";
    if (step.attempt_count + 1 < step.max_attempts) {
      const delay = Math.min(60_000, 2 ** step.attempt_count * 1_000);
      await updateStep(step.id, { status: "queued", error: message, run_after: new Date(Date.now() + delay).toISOString() });
      await appendEvent(taskId, organizationId, "step.retry_scheduled", { stepId: step.id, error: message, delayMs: delay });
    } else {
      await updateStep(step.id, { status: "failed", error: message, finished_at: new Date().toISOString() });
      await updateTask(taskId, { status: "failed", error: `Step ${step.agent_id} failed: ${message}`, completed_at: new Date().toISOString() });
      await appendEvent(taskId, organizationId, "step.failed", { stepId: step.id, error: message });
    }
  }
}

async function nextSpend(taskId: string, delta: number) {
  const db = createAdminClient();
  const { data } = await db.from("tasks").select("spent_cost_cents").eq("id", taskId).single();
  return Number(data?.spent_cost_cents ?? 0) + delta;
}

async function createApproval(taskId: string, organizationId: string, stepId: string, agentId: string, reason: string) {
  const db = createAdminClient();
  const { error } = await db.from("approvals").insert({ task_id: taskId, organization_id: organizationId, step_id: stepId, requested_by_agent_id: agentId, status: "pending", reason, action_type: "tool.use" });
  if (error) throw new Error(error.message);
}

async function finalizeTask(task: { id: string; organization_id: string; steps: Array<{ status: string; result: unknown }> }) {
  const finalResult = task.steps.at(-1)?.result ?? null;
  await updateTask(task.id, { status: "verified", final_result: finalResult, completed_at: new Date().toISOString(), lease_owner: null, lease_until: null });
  await appendEvent(task.id, task.organization_id, "task.verified", {});
}
