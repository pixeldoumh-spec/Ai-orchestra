import type { RiskLevel } from "@/lib/core/policy";
import type { WorkflowPlan } from "@/lib/core/workflow";

export type AgentStatus = "healthy" | "degraded" | "offline";
export type TaskStatus = "queued" | "running" | "awaiting_approval" | "verified" | "failed" | "cancelled";
export type StepStatus = TaskStatus;
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

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

export interface FunctionModelTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

export interface WebSearchModelTool {
  type: "web_search";
}

export interface FileSearchModelTool {
  type: "file_search";
  vector_store_ids: string[];
  max_num_results?: number;
}

export type ModelTool = FunctionModelTool | WebSearchModelTool | FileSearchModelTool;

export interface ModelFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface ModelCitation {
  kind: "url" | "file";
  url?: string;
  title?: string;
  fileId?: string;
  filename?: string;
  startIndex?: number;
  endIndex?: number;
}

export interface ModelOutputSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface ModelCompleteInput {
  system: string;
  user?: string;
  inputItems?: unknown[];
  model?: string | null;
  tools?: ModelTool[];
  outputSchema?: ModelOutputSchema | null;
  reasoningEffort?: ReasoningEffort | null;
  verbosity?: "low" | "medium" | "high" | null;
}

export interface ModelResult {
  output: unknown;
  outputText: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  usageCents: number;
  responseId?: string;
  responseItems?: unknown[];
  functionCalls?: ModelFunctionCall[];
  citations?: ModelCitation[];
  model?: string;
  status?: string;
}

export interface ModelAdapter {
  complete(input: ModelCompleteInput): Promise<ModelResult>;
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
  execution_region?: string | null;
  plan_json: WorkflowPlan;
  final_result: unknown;
  error: string | null;
  steps: PersistedStep[];
}
