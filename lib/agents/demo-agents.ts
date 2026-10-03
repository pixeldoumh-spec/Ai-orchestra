import type { AgentAdapter, AgentDefinition } from "../orchestrator/types";
import { registerAgent } from "../orchestrator/store";

export const demoAgents: AgentDefinition[] = [
  {
    id: "research",
    name: "Research Agent",
    description: "Collects inputs needed to answer a task.",
    capabilities: ["research", "summarize"],
    permissions: ["read:web"],
    budgetCents: 100,
    status: "healthy",
    version: "0.1.0",
  },
  {
    id: "analysis",
    name: "Analysis Agent",
    description: "Turns structured inputs into an analysis.",
    capabilities: ["analysis", "reasoning"],
    permissions: ["read:task-context"],
    budgetCents: 150,
    status: "healthy",
    version: "0.1.0",
  },
  {
    id: "writer",
    name: "Writer Agent",
    description: "Produces a polished user-facing result.",
    capabilities: ["writing", "formatting"],
    permissions: ["read:task-context", "write:artifact"],
    budgetCents: 100,
    status: "healthy",
    version: "0.1.0",
  },
  {
    id: "verifier",
    name: "Verifier Agent",
    description: "Checks whether a workflow result satisfies its contract.",
    capabilities: ["verification", "quality-control"],
    permissions: ["read:task-context", "read:artifact"],
    budgetCents: 75,
    status: "healthy",
    version: "0.1.0",
  },
];

demoAgents.forEach(registerAgent);

export const demoAdapter: AgentAdapter = {
  async run(agent, context) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      verified: agent.id === "verifier" ? true : false,
      usageCents: agent.budgetCents,
      output: {
        agent: agent.id,
        objective: context.objective,
        message: `${agent.name} completed its assigned step for: ${context.goal}`,
      },
    };
  },
};
