export type Permission = string;

export type AgentStatus = "healthy" | "degraded" | "offline";
export type TaskStatus = "queued" | "running" | "awaiting_approval" | "verified" | "failed";
export type StepStatus = "queued" | "running" | "verified" | "failed";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  permissions: Permission[];
  budgetCents: number;
  status: AgentStatus;
  version: string;
}

export interface TaskStep {
  id: string;
  agentId: string;
  objective: string;
  status: StepStatus;
  result?: unknown;
  error?: string;
}

export interface TaskRecord {
  id: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
  steps: TaskStep[];
  finalResult?: unknown;
}

export interface AgentRunContext {
  taskId: string;
  goal: string;
  objective: string;
  priorResults: unknown[];
}

export interface AgentRunResult {
  output: unknown;
  verified: boolean;
  usageCents: number;
}

export interface AgentAdapter {
  run(agent: AgentDefinition, context: AgentRunContext): Promise<AgentRunResult>;
}
