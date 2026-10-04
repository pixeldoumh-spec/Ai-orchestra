import { createAdminClient } from "@/lib/supabase/admin";
import { createEvidencePacket } from "@/lib/evidence/repository";
import { completeToolInvocationForConnectorRequest, updateConnectorRequestStatus } from "./repository";
import { decryptSecret, hashJson } from "@/lib/vault/crypto";
import type { ToolResult } from "@/lib/orchestrator/types";

const MAX_RESPONSE_BYTES = Math.min(
  1_048_576,
  Math.max(16_384, Number(process.env.CONNECTOR_WRITE_MAX_BYTES ?? "524288")),
);
const MAX_BODY_CHARS = 50_000;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function parseAction(raw: unknown): { method: string; path: string } {
  const action = String(raw ?? "").trim();
  const match = action.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[^\s]*)$/i);
  if (!match || !ALLOWED_METHODS.has(match[1].toUpperCase())) {
    throw new Error("External action must use METHOD /normalized-path");
  }
  const path = match[2];
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\\\") ||
    path.includes("/../") ||
    path.includes("/./") ||
    path.length > 2000
  ) {
    throw new Error("External action path is not a normalized relative connector path");
  }
  return { method: match[1].toUpperCase(), path };
}

function sanitizeEvidenceText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(x-api-key\s*:\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*["'])[^"']+(["'])/gi, "$1[redacted]$2")
    .slice(0, 4000);
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Connector response exceeds the configured read limit");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Connector response exceeds the configured read limit");
      }
      chunks.push(part.value);
    }
  } else {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > MAX_RESPONSE_BYTES) throw new Error("Connector response exceeds the configured read limit");
    chunks.push(buf);
    total = buf.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function requestWithTimeout(target: URL, init: RequestInit): Promise<Response> {
  const timeoutMs = Math.min(
    60_000,
    Math.max(5_000, Number(process.env.CONNECTOR_WRITE_TIMEOUT_MS ?? "20_000")),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(target.toString(), {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Connector request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCredential(input: {
  organizationId: string;
  connectorId: string;
  credentialId: string | null;
}) {
  if (!input.credentialId) return null;
  const db = createAdminClient();
  const { data, error } = await db
    .from("connector_credentials")
    .select("secret_ciphertext,secret_iv,secret_auth_tag,key_version,auth_scheme,status,expires_at,scopes")
    .eq("organization_id", input.organizationId)
    .eq("connector_id", input.connectorId)
    .eq("id", input.credentialId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.status !== "active") throw new Error("Connector credential is not active");
  if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) throw new Error("Connector credential has expired");
  const secret = decryptSecret({
    ciphertext: data.secret_ciphertext,
    iv: data.secret_iv,
    authTag: data.secret_auth_tag,
    keyVersion: Number(data.key_version),
  });
  return {
    secret,
    authScheme: data.auth_scheme as "none" | "bearer" | "api_key" | "hmac",
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
  };
}

export async function executePreparedConnectorRequest(input: {
  organizationId: string;
  connectorRequestId: string;
  actorUserId?: string | null;
}) {
  const db = createAdminClient();
  const { data: request, error: requestError } = await db
    .from("connector_requests")
    .select("id,organization_id,task_id,step_id,agent_id,connector_id,credential_id,request_id,status,expires_at,input_ciphertext,input_iv,input_auth_tag,input_key_version,action_method,action_path")
    .eq("organization_id", input.organizationId)
    .eq("id", input.connectorRequestId)
    .single();
  if (requestError || !request) throw new Error("Connector request not found");
  if (request.status !== "approved") throw new Error(`Connector request is not approved (${request.status})`);
  const { data: claimed, error: claimError } = await db
    .from("connector_requests")
    .update({ status: "executing", completed_at: null })
    .eq("organization_id", input.organizationId)
    .eq("id", request.id)
    .eq("status", "approved")
    .select("id,organization_id,task_id,step_id,agent_id,connector_id,credential_id,request_id,status,expires_at,input_ciphertext,input_iv,input_auth_tag,input_key_version,action_method,action_path")
    .maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimed) throw new Error("Connector request is already executing or is no longer approved");
  Object.assign(request, claimed);
  if (Date.parse(request.expires_at) <= Date.now()) {
    await updateConnectorRequestStatus(request.id, "failed");
    throw new Error("Connector request has expired");
  }
  if (!request.input_ciphertext || !request.input_iv || !request.input_auth_tag || !request.input_key_version) {
    throw new Error("Connector request does not contain a resumable encrypted intent");
  }

  const decrypted = decryptSecret({
    ciphertext: request.input_ciphertext,
    iv: request.input_iv,
    authTag: request.input_auth_tag,
    keyVersion: Number(request.input_key_version),
  });
  let envelope: { toolId?: unknown; input?: unknown };
  try {
    envelope = JSON.parse(decrypted);
  } catch {
    throw new Error("Connector request intent is invalid");
  }
  const toolId = String(envelope.toolId ?? "");
  if (toolId !== "external.action") {
    throw new Error("Only external.action requests can be resumed through approval");
  }
  const actionInput = envelope.input && typeof envelope.input === "object"
    ? envelope.input as Record<string, unknown>
    : {};
  const { method, path } = parseAction(actionInput.action);
  if (request.action_method && request.action_method !== method) throw new Error("Approved connector method does not match stored intent");
  if (request.action_path && request.action_path !== path) throw new Error("Approved connector path does not match stored intent");

  const { data: connector, error: connectorError } = await db
    .from("connectors")
    .select("id,name,kind,base_url,auth_scheme,status,circuit_state,cooldown_until")
    .eq("organization_id", input.organizationId)
    .eq("id", request.connector_id)
    .single();
  if (connectorError || !connector) throw new Error("Connector not found");
  if (connector.kind !== "http") throw new Error("External action requires an HTTP connector");
  if (connector.status === "disabled") throw new Error("Connector is disabled");
  if (connector.status === "degraded") throw new Error("Connector is degraded");
  if (connector.circuit_state === "open" && connector.cooldown_until && Date.parse(connector.cooldown_until) > Date.now()) {
    throw new Error("Connector circuit is open");
  }
  if (!connector.base_url || !connector.base_url.startsWith("https://")) {
    throw new Error("Connector must have an HTTPS base URL");
  }

  const base = new URL(connector.base_url);
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error("Connector action escaped the configured origin");

  const payload = actionInput.input ?? null;
  const body = method === "GET" || method === "HEAD" ? null : JSON.stringify(payload);
  if (body && body.length > 100_000) throw new Error("External action payload exceeds 100 KB");

  if (method === "GET" || method === "HEAD") {
    const query = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    for (const [key, value] of Object.entries(query)) {
      if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(key)) throw new Error("Invalid connector query parameter name");
      target.searchParams.set(key, String(value).slice(0, 500));
    }
  }

  const headers = new Headers({
    Accept: "application/json, text/plain;q=0.9, */*;q=0.1",
    "X-Connector-Request-Id": request.request_id,
  });
  if (body) {
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", request.request_id);
  }

  const credential = await resolveCredential({
    organizationId: input.organizationId,
    connectorId: connector.id,
    credentialId: request.credential_id,
  });
  if (connector.auth_scheme !== "none") {
    if (!credential) throw new Error("Connector credential is required");
    if (credential.authScheme !== connector.auth_scheme) throw new Error("Connector credential scheme mismatch");
    if (connector.auth_scheme === "bearer") headers.set("Authorization", `Bearer ${credential.secret}`);
    else if (connector.auth_scheme === "api_key") headers.set("X-API-Key", credential.secret);
    else if (connector.auth_scheme === "hmac") {
      const signingPayload = [request.request_id, method, target.pathname + target.search, hashJson(body ?? "")].join("\n");
      const cryptoKey = await globalThis.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(credential.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await globalThis.crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        new TextEncoder().encode(signingPayload),
      );
      const signatureBytes = new Uint8Array(signature);
      let signatureB64 = "";
      if (typeof btoa === "function") {
        let binary = "";
        for (const byte of signatureBytes) binary += String.fromCharCode(byte);
        signatureB64 = btoa(binary);
      } else {
        signatureB64 = Array.from(signatureBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      headers.set("X-Connector-Signature", signatureB64);
    }
  }

  const started = Date.now();
  let completedSuccessfully = false;
  let responseStatus: number | null = null;
  try {
    const response = await requestWithTimeout(target, {
      method,
      headers,
      body: body ?? undefined,
    });
    responseStatus = response.status;
    const responseBody = await readBoundedBody(response);
    const contentHash = hashJson({
      method,
      url: target.toString(),
      status: response.status,
      body: responseBody,
    });
    const latencyMs = Date.now() - started;
    const resultOutput = {
      executed: response.ok,
      requestId: request.request_id,
      method,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      url: target.toString(),
      body: responseBody.slice(0, MAX_BODY_CHARS),
      truncated: responseBody.length > MAX_BODY_CHARS,
      contentHash,
    };

    const evidence = await createEvidencePacket({
      organizationId: input.organizationId,
      taskId: request.task_id,
      stepId: request.step_id,
      agentId: request.agent_id,
      sourceType: "connector",
      sourceUrl: target.toString(),
      sourceTitle: typeof connector.name === "string" ? connector.name : "Connector",
      connectorId: connector.id,
      externalRef: request.request_id,
      excerpt: sanitizeEvidenceText(responseBody),
      contentHash,
      confidence: response.ok ? 1 : 0,
      metadata: {
        method,
        http_status: response.status,
        content_type: response.headers.get("content-type"),
        actor_user_id: input.actorUserId ?? null,
        idempotency_key: method === "GET" || method === "HEAD" ? null : request.request_id,
      },
    });

    await updateConnectorRequestStatus(request.id, response.ok ? "executed" : "failed");
    const result: ToolResult = {
      output: { ...resultOutput, evidencePacketId: evidence.id },
      approved: true,
      requestId: request.request_id,
      connectorRequestId: request.id,
      connectorId: connector.id,
    };
    await completeToolInvocationForConnectorRequest({
      organizationId: input.organizationId,
      connectorRequestId: request.id,
      status: response.ok ? "executed" : "failed",
      result,
    });
    completedSuccessfully = response.ok;
    await db.rpc("record_connector_outcome", {
      p_organization_id: input.organizationId,
      p_connector_id: connector.id,
      p_success: response.ok,
      p_latency_ms: latencyMs,
      p_http_status: response.status,
      p_error_class: response.ok ? null : `http_${response.status}`,
      p_source: "agent.connector.external.action",
      p_now: new Date().toISOString(),
    });
    return { connectorRequestId: request.id, toolId, result };
  } catch (error) {
    try { await updateConnectorRequestStatus(request.id, "failed"); } catch {}
    try {
      await db.rpc("record_connector_outcome", {
        p_organization_id: input.organizationId,
        p_connector_id: connector.id,
        p_success: false,
        p_latency_ms: Date.now() - started,
        p_http_status: responseStatus,
        p_error_class: error instanceof Error ? error.message.slice(0, 120) : "connector_execution_error",
        p_source: "agent.connector.external.action",
        p_now: new Date().toISOString(),
      });
    } catch {}
    throw error instanceof Error ? error : new Error("Connector execution failed");
  }
}
