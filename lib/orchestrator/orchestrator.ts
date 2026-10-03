import { demoAdapter } from "../agents/demo-agents";
import { getAgent, saveTask } from "./store";
import type { AgentAdapter, TaskRecord } from "./types";

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export async function executeGoal(goal: string, adapter: AgentAdapter = demoAdapter): Promise<TaskRecord> {
  const task: TaskRecord = {
    id: id("task"),
    goal,
    status: "running",
    createdAt: new Date().toISOString(),
    steps: [
      { id: id("step"), agentId: "research", objective: "Collect relevant inputs", status: "queued" },
      { id: id("step"), agentId: "analysis", objective: "Analyze collected inputs", status: "queued" },
      { id: id("step"), agentId: "writer", objective: "Draft the result", status: "queued" },
      { id: id("step"), agentId: "verifier", objective: "Verify the completed result", status: "queued" },
    ],
  };
  saveTask(task);

  const priorResults: unknown[] = [];
  for (const step of task.steps) {
    const agent = getAgent(step.agentId);
    if (!agent || agent.status === "offline") {
      step.status = "failed";
      step.error = "Agent unavailable";
      task.status = "failed";
      saveTask(task);
      return task;
    }

    step.status = "running";
    saveTask(task);
    const result = await adapter.run(agent, {
      taskId: task.id,
      goal,
      objective: step.objective,
      priorResults,
    });
    step.result = result.output;
    priorResults.push(result.output);
    step.status = agent.id === "verifier" && !result.verified ? "failed" : "verified";

    if (step.status === "failed") {
      task.status = "failed";
      saveTask(task);
      return task;
    }
    saveTask(task);
  }

  task.status = "verified";
  task.finalResult = priorResults.at(-1);
  saveTask(task);
  return task;
}
