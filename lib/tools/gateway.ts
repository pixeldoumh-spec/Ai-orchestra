import type { AgentDefinition, ToolDefinition, ToolInvocation, ToolResult } from "@/lib/orchestrator/types";
import { canUsePermission, requiresApproval } from "@/lib/core/policy";
import { createAdminClient } from "@/lib/supabase/admin";
import { prepareConnectorRequest, recordToolInvocation } from "@/lib/connectors/repository";
import { hashJson } from "@/lib/vault/crypto";
import { acknowledgeNetworkMessage, claimNetworkMessages, sendAgentMessage } from "@/lib/network/repository";

export const builtinTools: ToolDefinition[] = [
  { id: "time.now", name: "Current time", description: "Returns server time in ISO format.", permission: "time.read", risk: "low" },
  { id: "artifact.write", name: "Write artifact", description: "Persists a bounded task artifact.", permission: "artifact.write", risk: "medium" },
  { id: "agent.message.send", name: "Send agent message", description: "Send a signed message to a trusted peer agent.", permission: "network.send", risk: "medium" },
  { id: "agent.message.receive", name: "Receive agent messages", description: "Claim queued messages from this agent's durable inbox.", permission: "network.receive", risk: "low" },
  { id: "agent.message.ack", name: "Acknowledge agent message", description: "Acknowledge or fail a delivered peer message.", permission: "network.ack", risk: "low" },
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


  if (tool.id === "agent.message.send") {
    const input = invocation.input as { recipientAgentId?: unknown; subject?: unknown; payload?: unknown; scope?: unknown; kind?: unknown; conversationId?: unknown; correlationId?: unknown; replyToMessageId?: unknown; ttlSeconds?: unknown; priority?: unknown } | null;
    const recipientAgentId = String(input?.recipientAgentId ?? "");
    const subject = String(input?.subject ?? "").trim();
    if (!recipientAgentId || !subject) throw new Error("agent.message.send requires recipientAgentId and subject");
    const message = await sendAgentMessage({
      organizationId: agent.organizationId, senderAgentId: agent.id, recipientAgentId, subject,
      payload: input?.payload ?? null,
      scope: typeof input?.scope === "string" ? input.scope : undefined,
      kind: input?.kind as "request" | "response" | "event" | "delegation" | undefined,
      conversationId: typeof input?.conversationId === "string" ? input.conversationId : null,
      correlationId: typeof input?.correlationId === "string" ? input.correlationId : null,
      replyToMessageId: typeof input?.replyToMessageId === "string" ? input.replyToMessageId : null,
      ttlSeconds: typeof input?.ttlSeconds === "number" ? input.ttlSeconds : undefined,
      priority: typeof input?.priority === "number" ? input.priority : undefined
    });
    const result = { output: { sent: true, messageId: message.messageId, recipientAgentId: message.recipientAgentId, conversationId: message.conversationId, status: message.status }, approved: true };
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "executed", result });
    return result;
  }

  if (tool.id === "agent.message.receive") {
    const input = invocation.input as { limit?: unknown } | null;
    const messages = await claimNetworkMessages({ organizationId: agent.organizationId, agentId: agent.id, limit: typeof input?.limit === "number" ? input.limit : 20 });
    const result = { output: { messages }, approved: true };
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "executed", result });
    return result;
  }

  if (tool.id === "agent.message.ack") {
    const input = invocation.input as { messageId?: unknown; success?: unknown; error?: unknown } | null;
    const messageId = String(input?.messageId ?? "");
    if (!messageId) throw new Error("agent.message.ack requires messageId");
    const message = await acknowledgeNetworkMessage({
      organizationId: agent.organizationId, agentId: agent.id, messageId,
      success: input?.success !== false,
      error: typeof input?.error === "string" ? input.error : null
    });
    const result = { output: { acknowledged: true, messageId: message.messageId, status: message.status }, approved: true };
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "executed", result });
    return result;
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
