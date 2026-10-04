import type { AgentDefinition, ModelTool, ToolDefinition, ToolInvocation, ToolResult } from "@/lib/orchestrator/types";
import { canUsePermission, requiresApproval } from "@/lib/core/policy";
import { createAdminClient } from "@/lib/supabase/admin";
import { prepareConnectorRequest, recordToolInvocation, updateConnectorRequestStatus } from "@/lib/connectors/repository";
import { decryptSecret, hashJson } from "@/lib/vault/crypto";
import { acknowledgeNetworkMessage, claimNetworkMessages, sendAgentMessage } from "@/lib/network/repository";
import { delegateToAgent } from "@/lib/network/delegation";
import { createEvidencePacket } from "@/lib/evidence/repository";
import { sanitizeConnectorUrl, sanitizeConnectorText } from "@/lib/connectors/safety";

export const builtinTools: ToolDefinition[] = [
  { id: "time.now", name: "Current time", description: "Returns server time in ISO format.", permission: "time.read", risk: "low" },
  { id: "connector.http.get", name: "Connector HTTP GET", description: "Reads a resource from an explicitly configured tenant connector using the connector route and stored credential.", permission: "connector.read", risk: "low" },
  { id: "artifact.write", name: "Write artifact", description: "Persists a bounded task artifact.", permission: "artifact.write", risk: "medium" },
  { id: "agent.message.send", name: "Send agent message", description: "Send a signed message to a trusted peer agent.", permission: "network.send", risk: "medium" },
  { id: "agent.message.receive", name: "Receive agent messages", description: "Claim queued messages from this agent's durable inbox.", permission: "network.receive", risk: "low" },
  { id: "agent.message.ack", name: "Acknowledge agent message", description: "Acknowledge or fail a delivered peer message.", permission: "network.ack", risk: "low" },
  { id: "agent.delegate", name: "Delegate work to agent", description: "Autonomously delegate bounded work to a trusted peer agent and receive a signed response.", permission: "network.delegate", risk: "medium" },
  { id: "external.action", name: "External action", description: "Prepare an external side effect through the signed connector and approval pipeline.", permission: "external.execute", risk: "high" },
];

const nullableString = () => ({ anyOf: [{ type: "string" }, { type: "null" }] });

const modelParameters: Record<string, Record<string, unknown>> = {
  "time.now": {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  "connector.http.get": {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative HTTPS path beginning with / on the configured connector." },
      query: { type: "object", description: "Optional query parameters.", additionalProperties: { type: "string" } },
    },
    required: ["path", "query"],
    additionalProperties: false,
  },
  "artifact.write": {
    type: "object",
    properties: {
      name: { type: "string", description: "Artifact filename." },
      content: { type: "string", description: "Artifact contents." },
    },
    required: ["name", "content"],
    additionalProperties: false,
  },
  "agent.message.send": {
    type: "object",
    properties: {
      recipientAgentId: { type: "string" },
      subject: { type: "string" },
      payload: { type: "string", description: "JSON-encoded payload." },
      scope: { type: "string" },
      kind: { type: "string", enum: ["request", "response", "event", "delegation"] },
      conversationId: nullableString(),
      correlationId: nullableString(),
      replyToMessageId: nullableString(),
      ttlSeconds: { type: "integer" },
      priority: { type: "integer" },
    },
    required: ["recipientAgentId", "subject", "payload", "scope", "kind", "conversationId", "correlationId", "replyToMessageId", "ttlSeconds", "priority"],
    additionalProperties: false,
  },
  "agent.delegate": {
    type: "object",
    properties: {
      recipientAgentId: { type: "string" },
      objective: { type: "string", description: "The bounded objective the peer must complete." },
      context: { type: "object", description: "Optional structured context supplied as untrusted task data.", additionalProperties: true },
      scope: { type: "string" },
      ttlSeconds: { type: "integer" },
      priority: { type: "integer" },
      maxCostCents: { type: "integer" },
    },
    required: ["recipientAgentId", "objective", "context", "scope", "ttlSeconds", "priority", "maxCostCents"],
    additionalProperties: false,
  },
  "agent.message.receive": {
    type: "object",
    properties: {
      limit: { type: "integer" },
    },
    required: ["limit"],
    additionalProperties: false,
  },
  "agent.message.ack": {
    type: "object",
    properties: {
      messageId: { type: "string" },
      success: { type: "boolean" },
      error: nullableString(),
    },
    required: ["messageId", "success", "error"],
    additionalProperties: false,
  },
  "external.action": {
    type: "object",
    properties: {
      action: { type: "string" },
      input: { type: "string", description: "JSON-encoded action input." },
    },
    required: ["action", "input"],
    additionalProperties: false,
  },
};

function modelToolName(toolId: string): string {
  return toolId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function getModelTools(agent: AgentDefinition): ModelTool[] {
  return builtinTools
    .filter((tool) => agent.tools.includes(tool.id) && modelParameters[tool.id])
    .map((tool) => ({
      type: "function",
      name: modelToolName(tool.id),
      description: tool.description,
      parameters: modelParameters[tool.id],
      strict: true,
    }));
}

export function resolveModelToolId(name: string): string | null {
  const tool = builtinTools.find((candidate) => modelToolName(candidate.id) === name);
  return tool?.id ?? null;
}

async function executeConnectorRead(input: {
  organizationId: string;
  taskId: string;
  stepId: string;
  agent: AgentDefinition;
  path: string;
  query: Record<string, unknown>;
}): Promise<ToolResult & { connectorRequestId?: string | null }> {
  const {
    organizationId,
    taskId,
    stepId,
    agent,
    path,
    query,
  } = input;

  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\..") || path.includes("/../") || path.includes("/./")) {
    throw new Error("Connector path must be a normalized relative path beginning with /");
  }
  if (path.length > 2000) throw new Error("Connector path is too long");

  const route = await prepareConnectorRequest({
    organizationId,
    taskId,
    stepId,
    agent,
    toolInvocation: { toolId: "connector.http.get", input: { path, query } },
  });

  const db = createAdminClient();
  const { data: connector } = await db
    .from("connectors")
    .select("id,name,base_url,auth_scheme")
    .eq("organization_id", organizationId)
    .eq("id", route.connector_id)
    .single();
  if (!connector?.base_url) throw new Error("Connector is missing an HTTPS base URL");

  const base = new URL(connector.base_url);
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error("Connector request escaped the configured origin");

  for (const [key, value] of Object.entries(query)) {
    if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(key)) throw new Error("Invalid connector query parameter name");
    target.searchParams.set(key, String(value).slice(0, 500));
  }

  const headers = new Headers({ Accept: "application/json, text/plain;q=0.9, */*;q=0.1" });
  if (connector.auth_scheme !== "none") {
    if (!route.credential_id) throw new Error("Connector credential is required");
    const { data: credential, error } = await db
      .from("connector_credentials")
      .select("secret_ciphertext,secret_iv,secret_auth_tag,key_version,auth_scheme,status,expires_at")
      .eq("organization_id", organizationId)
      .eq("connector_id", connector.id)
      .eq("id", route.credential_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!credential || credential.status !== "active") throw new Error("Connector credential is not active");
    if (credential.expires_at && Date.parse(credential.expires_at) <= Date.now()) throw new Error("Connector credential has expired");
    const secret = decryptSecret({
      ciphertext: credential.secret_ciphertext,
      iv: credential.secret_iv,
      authTag: credential.secret_auth_tag,
      keyVersion: Number(credential.key_version),
    });
    if (credential.auth_scheme === "bearer") headers.set("Authorization", `Bearer ${secret}`);
    else if (credential.auth_scheme === "api_key") headers.set("X-API-Key", secret);
    else throw new Error("HMAC connector authentication is not implemented for V6.2 read tools");
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(30_000, Math.max(5_000, Number(process.env.CONNECTOR_READ_TIMEOUT_MS ?? "15000"))));

  try {
    const response = await fetch(target.toString(), {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });

    const declared = Number(response.headers.get("content-length") ?? "0");
    const maxBytes = Math.min(524288, Math.max(16384, Number(process.env.CONNECTOR_READ_MAX_BYTES ?? "524288")));
    if (declared > maxBytes) throw new Error("Connector response exceeds the 512 KiB read limit");

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const chunk = part.value;
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("Connector response exceeds the 512 KiB read limit");
        }
        chunks.push(chunk);
      }
    } else {
      const buf = new Uint8Array(await response.arrayBuffer());
      total = buf.byteLength;
      if (total > maxBytes) throw new Error("Connector response exceeds the 512 KiB read limit");
      chunks.push(buf);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder().decode(merged);
    const fingerprint = hashJson({ url: target.toString(), status: response.status, body }).slice(0, 64);
    const healthDb = createAdminClient();
    await healthDb.rpc("record_connector_outcome", {
      p_organization_id: organizationId,
      p_connector_id: connector.id,
      p_success: response.ok,
      p_latency_ms: Date.now() - started,
      p_http_status: response.status,
      p_error_class: response.ok ? null : `http_${response.status}`,
      p_source: "agent.connector.http.get",
      p_now: new Date().toISOString(),
    });

    const evidence = await createEvidencePacket({
      organizationId,
      taskId,
      stepId,
      agentId: agent.id,
      sourceType: "connector",
      sourceTitle: typeof connector.name === "string" ? connector.name : undefined,
      sourceUrl: sanitizeConnectorUrl(target.toString()),
      connectorId: connector.id,
      externalRef: route.request_id,
      contentHash: fingerprint,
      metadata: {
        http_status: response.status,
        content_type: response.headers.get("content-type"),
        truncated: body.length > 50_000,
      },
    });
    await updateConnectorRequestStatus(route.id, "executed");
    return {
      output: {
        evidencePacketId: evidence.id,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        url: sanitizeConnectorUrl(target.toString()),
        body: sanitizeConnectorText(body, 50_000),
        truncated: body.length > 50_000,
        contentHash: fingerprint,
      },
      approved: true,
      connectorId: connector.id,
      connectorRequestId: route.request_id,
    };
  } catch (error) {
    try { await updateConnectorRequestStatus(route.id, "failed"); } catch {}
    await createAdminClient().rpc("record_connector_outcome", {
      p_organization_id: organizationId,
      p_connector_id: connector.id,
      p_success: false,
      p_latency_ms: Date.now() - started,
      p_http_status: null,
      p_error_class: error instanceof Error ? error.message.slice(0, 120) : "connector_fetch_error",
      p_source: "agent.connector.http.get",
      p_now: new Date().toISOString(),
    });
    throw error instanceof Error && error.name === "AbortError"
      ? new Error("Connector request timed out")
      : error;
  } finally {
    clearTimeout(timer);
  }
}

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
    let payload = input?.payload ?? null;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch {}
    }
    const message = await sendAgentMessage({
      organizationId: agent.organizationId,
      senderAgentId: agent.id,
      recipientAgentId,
      subject,
      payload,
      scope: typeof input?.scope === "string" ? input.scope : undefined,
      kind: input?.kind as "request" | "response" | "event" | "delegation" | undefined,
      conversationId: typeof input?.conversationId === "string" ? input.conversationId : null,
      correlationId: typeof input?.correlationId === "string" ? input.correlationId : null,
      replyToMessageId: typeof input?.replyToMessageId === "string" ? input.replyToMessageId : null,
      ttlSeconds: typeof input?.ttlSeconds === "number" ? input.ttlSeconds : undefined,
      priority: typeof input?.priority === "number" ? input.priority : undefined,
    });
    const result = { output: { sent: true, messageId: message.messageId, recipientAgentId: message.recipientAgentId, conversationId: message.conversationId, status: message.status }, approved: true };
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "executed", result });
    return result;
  }

  if (tool.id === "agent.delegate") {
    const input = invocation.input as { recipientAgentId?: unknown; objective?: unknown; context?: unknown; scope?: unknown; ttlSeconds?: unknown; priority?: unknown; maxCostCents?: unknown } | null;
    const recipientAgentId = String(input?.recipientAgentId ?? "").trim();
    const objective = String(input?.objective ?? "").trim();
    if (!recipientAgentId || objective.length < 5) throw new Error("agent.delegate requires recipientAgentId and a useful objective");
    const delegated = await delegateToAgent({
      organizationId: agent.organizationId,
      taskId,
      stepId,
      senderAgent: agent,
      recipientAgentId,
      objective: objective.slice(0, 4000),
      context: input?.context ?? null,
      scope: typeof input?.scope === "string" ? input.scope : undefined,
      ttlSeconds: typeof input?.ttlSeconds === "number" ? input.ttlSeconds : undefined,
      priority: typeof input?.priority === "number" ? input.priority : undefined,
      maxCostCents: typeof input?.maxCostCents === "number" ? input.maxCostCents : undefined,
    });
    const result = { output: delegated, approved: true };
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
      organizationId: agent.organizationId,
      agentId: agent.id,
      messageId,
      success: input?.success !== false,
      error: typeof input?.error === "string" ? input.error : null,
    });
    const result = { output: { acknowledged: true, messageId: message.messageId, status: message.status }, approved: true };
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "executed", result });
    return result;
  }

  if (tool.id === "connector.http.get") {
    const input = invocation.input as { path?: unknown; query?: unknown } | null;
    const path = String(input?.path ?? "");
    const query = input?.query && typeof input.query === "object" ? input.query as Record<string, unknown> : {};
    const result = await executeConnectorRead({
      organizationId: agent.organizationId,
      taskId,
      stepId,
      agent,
      path,
      query,
    });
    await recordToolInvocation({ organizationId: agent.organizationId, taskId, stepId, agentId: agent.id, toolId: invocation.toolId, invocation, status: "executed", connectorRequestId: result.connectorRequestId, result });
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
