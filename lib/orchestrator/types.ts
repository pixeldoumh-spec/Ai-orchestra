import type { RiskLevel } from "@/lib/core/policy";
export type AgentStatus = "healthy" | "degraded" | "offline";
export type TaskStatus = "queued" | "running" | "awaiting_approval" | "verified" | "failed" | "cancelled";
export type StepStatus = TaskStatus;
export interface AgentDefinition { id:string; organizationId:string; name:string; description:string; capabilities:string[]; permissions:string[]; tools:string[]; budgetCents:number; status:AgentStatus; version:string; model?:string|null; }
export interface ToolDefinition { id:string; name:string; description:string; permission:string; risk:RiskLevel; }
export interface ToolInvocation { toolId:string; input:unknown; }
export interface ToolResult { output:unknown; approved?:boolean; approvalReason?:string; }
export interface AgentContext { taskId:string; organizationId:string; goal:string; objective:string; priorResults:unknown[]; availableTools:ToolDefinition[]; }
export interface ModelResult { output:unknown; inputTokens:number; outputTokens:number; usageCents:number; raw?:unknown; }
export interface ModelAdapter { complete(input:{system:string; user:string; model?:string|null}):Promise<ModelResult>; }
