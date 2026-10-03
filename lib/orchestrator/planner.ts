import { z } from "zod";
import { buildAdaptiveFallbackPlan, validatePlan, type WorkflowPlan } from "@/lib/core/workflow";
import type { AgentDefinition } from "./types";
import { getModelAdapter } from "./model";

const plannerStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  agentId: z.string().min(1).max(120),
  objective: z.string().trim().min(5).max(2000),
  dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/)).max(16),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  kind: z.enum(["work", "verification"]),
  verifies: z.array(z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/)).max(16).optional().default([]),
});

const plannerResponseSchema = z.object({
  rationale: z.string().trim().max(2000).optional(),
  steps: z.array(plannerStepSchema).min(2).max(16),
});

function extractJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? value).trim();
  try { return JSON.parse(candidate); } catch {}
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  throw new Error("Planner did not return valid JSON");
}

function fallbackIds(agents: AgentDefinition[]) {
  const used = new Set<string>();
  const pick = (capability: string, preferred: string) => {
    const candidates = agents.filter((agent) => agent.status !== "offline");
    const id = candidates.find((agent) => agent.id === preferred && !used.has(agent.id))?.id
      ?? candidates.find((agent) => agent.capabilities.includes(capability) && !used.has(agent.id))?.id
      ?? candidates.find((agent) => !used.has(agent.id))?.id;
    if (id) used.add(id);
    return id;
  };

  const research = pick("research", "research");
  const analysis = pick("analysis", "analysis");
  const writer = pick("writing", "writer");
  const verifier = pick("verification", "verifier");
  if (!research || !analysis || !writer || !verifier) throw new Error("No healthy agent set can satisfy the V3 fallback plan");
  return { research, analysis, writer, verifier };
}

export async function planWorkflow(input: {
  goal: string;
  agents: AgentDefinition[];
  priorResults?: unknown[];
  failureContext?: { stepId: string; agentId: string; error: string };
}): Promise<WorkflowPlan> {
  const available = new Set(input.agents.filter((agent) => agent.status !== "offline").map((agent) => agent.id));
  if (available.size < 4) throw new Error("At least four non-offline agents are required for V3 orchestration");

  if ((process.env.AI_MODEL_PROVIDER ?? "mock") === "mock") {
    return buildAdaptiveFallbackPlan(input.goal, fallbackIds(input.agents));
  }

  const agentCatalog = input.agents
    .filter((agent) => agent.status !== "offline")
    .map((agent) => ({ id: agent.id, capabilities: agent.capabilities, tools: agent.tools, budgetCents: agent.budgetCents }))
    .slice(0, 32);

  const model = getModelAdapter();
  const result = await model.complete({
    model: process.env.AI_PLANNER_MODEL ?? process.env.OPENAI_MODEL,
    system: `You are the V3 workflow planner. Convert the user's goal into a small executable DAG. You may only use the listed agents. Maximize safe parallelism when steps are independent. Include at least one verification step and make sure every terminal work step is explicitly covered by verification. Never include a step whose agent or dependency is not listed. Return JSON only with keys: rationale, steps[]. Each step has id, agentId, objective, dependsOn, maxAttempts, kind, verifies. No markdown.`,
    user: JSON.stringify({
      goal: input.goal,
      agents: agentCatalog,
      priorResults: input.priorResults?.slice(-12) ?? [],
      failureContext: input.failureContext ?? null,
    }),
  });

  const parsed = plannerResponseSchema.parse(extractJson(result.output));
  const plan: WorkflowPlan = { version: "v3", rationale: parsed.rationale, steps: parsed.steps };
  return validatePlan(plan, available);
}