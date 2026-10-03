import type { RiskLevel } from "@/lib/core/policy";
import type { WorkflowPlan } from "@/lib/core/workflow";

export type AgentStatus = "healthy" | "degraded" | "offline";
export type TaskStatus = "queued" | "running" | "awaiting_approval" | "verified" | "failed" | "cancelled";
export type StepStatus = TaskStatus;

export interface AgentDefinition {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  capabilities: string[];
  permissions: string[];
  tools: string[];
  budgetCents: number;
  status: AgentStatus;
  version: string;
  model?: string | null;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  permission: string;
  risk: RiskLevel;
}

export interface ToolInvocation {
  toolId: string;
  input: unknown;
}

export interface ToolResult {
  output: unknown;
  approved?: boolean;
  approvalReason?: string;
  requestId?: string;
  connectorRequestId?: string;
  connectorId?: string;
}

export interface AgentContext {
  taskId: string;
  organizationId: string;
  goal: string;
  objective: string;
  priorResults: unknown[];
  availableTools: ToolDefinition[];
}

export interface ModelResult {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  usageCents: number;
  raw?: unknown;
}

export interface ModelAdapter {
  complete(input: { system: string; user: string; model?: string | null }): Promise<ModelResult>;
}

export interface PersistedStep {
  id: string;
  agent_id: string;
  objective: string;
  status: StepStatus;
  depends_on: string[];
  max_attempts: number;
  attempt_count: number;
  result: unknown;
  checkpoint: unknown;
  error: string | null;
  usage_cents: number;
  usage_cents_total: number;
  kind: "work" | "verification";
  verifies: string[];
  plan_revision: number;
  started_at?: string | null;
  finished_at?: string | null;
  run_after?: string | null;
}

export interface PersistedTask {
  id: string;
  organization_id: string;
  goal: string;
  status: TaskStatus;
  max_cost_cents: number;
  spent_cost_cents: number;
  plan_version: string;
  plan_revision: number;
  replan_count: number;
  plan_json: WorkflowPlan;
  final_result: unknown;
  error: string | null;
  steps: PersistedStep[];
}