export type StepKind = "work" | "verification";

export interface PlannedStep {
  id: string;
  agentId: string;
  objective: string;
  dependsOn: string[];
  maxAttempts: number;
  kind: StepKind;
  verifies?: string[];
}

export interface WorkflowPlan {
  version: "v3";
  rationale?: string;
  steps: PlannedStep[];
}

export const MAX_PLAN_STEPS = 16;

export function validatePlan(plan: WorkflowPlan, availableAgentIds?: Set<string>): WorkflowPlan {
  if (plan.version !== "v3") throw new Error("Unsupported workflow plan version");
  if (!Array.isArray(plan.steps) || plan.steps.length < 2 || plan.steps.length > MAX_PLAN_STEPS) {
    throw new Error(`Workflow must contain 2-${MAX_PLAN_STEPS} steps`);
  }

  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(step.id)) throw new Error(`Invalid step id: ${step.id}`);
    if (ids.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (availableAgentIds && !availableAgentIds.has(step.agentId)) {
      throw new Error(`Planner selected unavailable agent: ${step.agentId}`);
    }
    if (!step.objective.trim() || step.objective.length > 2000) throw new Error(`Invalid objective for ${step.id}`);
    if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 5) {
      throw new Error(`Invalid maxAttempts for ${step.id}`);
    }
    if (step.dependsOn.includes(step.id)) throw new Error(`Step ${step.id} cannot depend on itself`);
    if (new Set(step.dependsOn).size !== step.dependsOn.length) throw new Error(`Duplicate dependency in ${step.id}`);
    if (step.kind === "verification" && (!step.verifies || step.verifies.length === 0)) {
      throw new Error(`Verification step ${step.id} must declare targets`);
    }
  }

  for (const step of plan.steps) {
    for (const dep of step.dependsOn) if (!ids.has(dep)) throw new Error(`Missing dependency ${dep} referenced by ${step.id}`);
    for (const target of step.verifies ?? []) if (!ids.has(target)) throw new Error(`Missing verification target ${target}`);
  }

  const verificationSteps = plan.steps.filter((step) => step.kind === "verification");
  if (verificationSteps.length === 0) throw new Error("Workflow must contain a verification step");
  const terminalWork = plan.steps.filter(
    (step) => step.kind === "work" && !plan.steps.some((candidate) => candidate.kind !== "verification" && candidate.dependsOn.includes(step.id)),
  );
  const verifiedTargets = new Set(verificationSteps.flatMap((step) => step.verifies ?? []));
  for (const step of terminalWork) {
    if (!verifiedTargets.has(step.id)) throw new Error(`Terminal work step ${step.id} is not covered by verification`);
  }

  // Kahn-style cycle detection. This is deliberately independent of insertion order.
  const pending = new Map(plan.steps.map((step) => [step.id, new Set(step.dependsOn)]));
  let resolved = 0;
  while (pending.size) {
    const ready = [...pending.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) throw new Error("Workflow contains a dependency cycle");
    for (const id of ready) {
      pending.delete(id);
      for (const deps of pending.values()) deps.delete(id);
      resolved += 1;
    }
  }
  if (resolved !== plan.steps.length) throw new Error("Workflow validation failed");

  return plan;
}

export function buildAdaptiveFallbackPlan(goal: string, agentIds: { research: string; analysis: string; writer: string; verifier: string }): WorkflowPlan {
  return validatePlan({
    version: "v3",
    rationale: "Safe deterministic fallback with an intentionally parallel evidence-gathering stage.",
    steps: [
      { id: "research_primary", agentId: agentIds.research, objective: `Gather the most relevant facts and inputs needed for: ${goal}`, dependsOn: [], maxAttempts: 3, kind: "work" },
      { id: "research_secondary", agentId: agentIds.research, objective: `Independently gather complementary evidence, edge cases, or counterpoints for: ${goal}`, dependsOn: [], maxAttempts: 3, kind: "work" },
      { id: "analysis", agentId: agentIds.analysis, objective: `Synthesize the available evidence into reliable conclusions for: ${goal}`, dependsOn: ["research_primary", "research_secondary"], maxAttempts: 3, kind: "work" },
      { id: "writer", agentId: agentIds.writer, objective: `Produce a concise, actionable answer for: ${goal}`, dependsOn: ["analysis"], maxAttempts: 3, kind: "work" },
      { id: "verifier", agentId: agentIds.verifier, objective: "Audit the proposed answer against the goal and identify unsupported, contradictory, or incomplete claims.", dependsOn: ["writer"], maxAttempts: 3, kind: "verification", verifies: ["writer"] },
    ],
  });
}

export function readyStepIds(
  steps: Array<{ id: string; status: string; depends_on: string[]; run_after?: string | null }>,
  now = Date.now(),
): string[] {
  const state = new Map(steps.map((s) => [s.id, s.status]));
  return steps
    .filter((step) => step.status === "queued")
    .filter((step) => !step.run_after || Date.parse(step.run_after) <= now)
    .filter((step) => step.depends_on.every((dep) => state.get(dep) === "verified"))
    .map((step) => step.id);
}

export function selectParallelBatch(
  readyIds: string[],
  agentBudgetById: Map<string, number>,
  remainingBudgetCents: number,
): string[] {
  if (remainingBudgetCents <= 0) return [];
  const batch: string[] = [];
  let plannedBudget = 0;
  for (const stepId of readyIds) {
    const budget = Math.max(0, Number(agentBudgetById.get(stepId) ?? 0));
    if (plannedBudget + budget <= remainingBudgetCents) {
      batch.push(stepId);
      plannedBudget += budget;
    }
  }
  return batch;
}