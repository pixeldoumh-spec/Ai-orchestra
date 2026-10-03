import type { AgentDefinition, ToolDefinition, ToolInvocation, ToolResult } from "@/lib/orchestrator/types";
import { canUsePermission, requiresApproval } from "@/lib/core/policy";
import { createAdminClient } from "@/lib/supabase/admin";
import { prepareConnectorRequest, recordToolInvocation } from "@/lib/connectors/repository";
import { hashJson } from "@/lib/vault/crypto";

export const builtinTools: ToolDefinition[] = [
  { id: "time.now", name: "Current time", description: "Returns server time in ISO format.", permission: "time.read", risk: "low" },
  { id: "artifact.write", name: "Write artifact", description: "Persists a bounded task artifact.", permission: "artifact.write", risk: "medium" },
  { id: "external.action", name: "External action", description: "Prepared through a signed connector request; side effects remain explicitly disabled until a connector adapter is approved.", permission: "external.execute", risk: "high" },
];

export async function invokeTool(agent: AgentDefinition, taskId: string, invocation: ToolInvocation, stepId = "unknown"): Promise<ToolResult> {
  const tool = builtinTools.find((candidate) => candidate.id === invocation.toolId);
  if (!tool) throw new Error(`Unknown tool: ${invocation.toolId}`);
  if (!agent.tools.includes(tool.id)) throw new Error(`Agent ${agent.id} is not allowed to use ${tool.id}`);
  if (!agent.permissions.includes(tool.permission)) throw new Error(`Missing permission ${tool.permission}`);

  if (requiresApproval(tool.risk)) {
    const prepared = await prepareConnectorRequest({ organizationId: agent.organizationId, taskId, stepId, agent, toolInvocation: invocation });
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "approval_required", connectorRequestId: prepared.id, result: { output: null, approved: false } });
    return {
      output: { prepared: true, connectorId: prepared.connector_id, requestId: prepared.request_id, expiresAt: prepared.expires_at },
      approved: false,
      approvalReason: `Approval required for ${tool.name}`,
      requestId: prepared.request_id,
      connectorRequestId: prepared.id,
      connectorId: prepared.connector_id,
    };
  }

  if (!canUsePermission({ agentPermissions: agent.permissions, requestedPermission: tool.permission, risk: tool.risk, approvalGranted: true })) {
    throw new Error(`Missing permission ${tool.permission}`);
  }

  if (tool.id === "time.now") {
    const output = new Date().toISOString();
    const result = { output, approved: true };
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "executed", result });
    return result;
  }

  if (tool.id === "artifact.write") {
    const input = invocation.input as { name?: unknown; content?: unknown } | null;
    const name = String(input?.name ?? "artifact.txt").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact.txt";
    const content = input?.content ?? null;
    const serialized = typeof content === "string" ? content : JSON.stringify(content);
    if (serialized.length > 20000) throw new Error("Artifact content exceeds the 20,000 character limit");
    const db = createAdminClient();
    const { error } = await db.from("task_artifacts").insert({ task_id: taskId, name, content });
    if (error) throw new Error(error.message);
    const result = { output: { saved: true, name, inputHash: hashJson(invocation.input) }, approved: true };
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "executed", result });
    return result;
  }

  throw new Error("Tool adapter is not implemented");
}
