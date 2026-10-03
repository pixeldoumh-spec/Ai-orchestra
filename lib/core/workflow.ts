export interface PlannedStep {
  id: string;
  agentId: string;
  objective: string;
  dependsOn: string[];
  maxAttempts: number;
}

export function buildDefaultPlan(goal: string): PlannedStep[] {
  return [
    { id: "research", agentId: "research", objective: `Collect the minimum useful inputs needed for: ${goal}`, dependsOn: [], maxAttempts: 3 },
    { id: "analysis", agentId: "analysis", objective: `Analyze the research and extract reliable conclusions for: ${goal}`, dependsOn: ["research"], maxAttempts: 3 },
    { id: "writer", agentId: "writer", objective: `Produce a concise, actionable result for: ${goal}`, dependsOn: ["analysis"], maxAttempts: 3 },
    { id: "verifier", agentId: "verifier", objective: "Verify the result against the original goal and identify unsupported claims", dependsOn: ["writer"], maxAttempts: 3 },
  ];
}

export function readyStepIds(steps: Array<{ id: string; status: string; depends_on: string[]; run_after?: string | null }>, now = Date.now()): string[] {
  const state = new Map(steps.map((s) => [s.id, s.status]));
  return steps.filter((step) => step.status === "queued").filter((step) => !step.run_after || Date.parse(step.run_after) <= now).filter((step) => step.depends_on.every((dep) => state.get(dep) === "verified")).map((step) => step.id);
}
