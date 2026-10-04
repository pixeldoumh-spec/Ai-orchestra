import { z } from "zod";
import { buildAdaptiveFallbackPlan, validatePlan, type WorkflowPlan } from "@/lib/core/workflow";
import type { AgentDefinition } from "./types";
import { getDefaultModel, getModelAdapter } from "./model";

const plannerStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  agentId: z.string().min(1).max(120),
  objective: z.string().trim().min(5).max(2000),
  dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/)).max(16),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  kind: z.enum(["work", "verification"]),
  verifies: z.array(z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/)).max(16).default([]),
});

const plannerResponseSchema = z.object({
  rationale: z.string().trim().max(2000).default(""),
  steps: z.array(plannerStepSchema).min(2).max(16),
});

const PLANNER_OUTPUT_SCHEMA = {
  name: "workflow_plan_v6_1",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      rationale: { type: "string" },
      steps: {
        type: "array",
        minItems: 2,
        maxItems: 16,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            agentId: { type: "string" },
            objective: { type: "string" },
            dependsOn: { type: "array", items: { type: "string" } },
            maxAttempts: { type: "integer" },
            kind: { type: "string", enum: ["work", "verification"] },
            verifies: { type: "array", items: { type: "string" } },
          },
          required: ["id", "agentId", "objective", "dependsOn", "maxAttempts", "kind", "verifies"],
        },
      },
    },
    required: ["rationale", "steps"],
  },
} as const;

function fallbackIds(agents: AgentDefinition[]) {
  const used = new Set<string>();
  const pick = (capability: string, preferred: string) => {
    const candidates = agents.filter((agent) => agent.status !== "offline");
    const id =
      candidates.find((agent) => agent.id === preferred && !used.has(agent.id))?.id ??
      candidates.find((agent) => agent.capabilities.includes(capability) && !used.has(agent.id))?.id ??
      candidates.find((agent) => !used.has(agent.id))?.id;
    if (id) used.add(id);
    return id;
  };

  const research = pick("research", "research");
  const analysis = pick("analysis", "analysis");
  const writer = pick("writing", "writer");
  const verifier = pick("verification", "verifier");
  if (!research || !analysis || !writer || !verifier) {
    throw new Error("No healthy agent set can satisfy the V3 fallback plan");
  }
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
    .map((agent) => ({
      id: agent.id,
      capabilities: agent.capabilities,
      tools: agent.tools,
      budgetCents: agent.budgetCents,
    }))
    .slice(0, 32);

  const model = getModelAdapter();
  const result = await model.complete({
    model: getDefaultModel("planner"),
    system: "You are the planning authority for AI Orchestra. Produce the smallest safe executable DAG that can satisfy the user's goal. Use only listed agents. Prefer useful parallelism for independent work. Include a verification step that covers all terminal work. Separate evidence gathering, reasoning, synthesis and verification. Do not fabricate tool access or external facts. Return only the required structured plan. Never expose private chain-of-thought.",
    user: JSON.stringify({
      goal: input.goal,
      agents: agentCatalog,
      priorResults: input.priorResults?.slice(-12) ?? [],
      failureContext: input.failureContext ?? null,
    }),
    outputSchema: PLANNER_OUTPUT_SCHEMA,
    reasoningEffort: (process.env.AI_PLANNER_REASONING_EFFORT as "low" | "medium" | "high" | "xhigh" | undefined) ?? "high",
    verbosity: "low",
  });

  const parsed = plannerResponseSchema.parse(result.output);
  const plan: WorkflowPlan = { version: "v3", rationale: parsed.rationale || undefined, steps: parsed.steps };
  return validatePlan(plan, available);
}
