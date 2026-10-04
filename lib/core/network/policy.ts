import type { AgentNetworkMessageKind } from "./protocol";

export interface AgentNetworkPolicy {
  organizationId: string;
  enabled: boolean;
  allowDelegation: boolean;
  allowedMessageTypes: AgentNetworkMessageKind[];
  allowedScopes: string[];
  maxDelegationDepth: number;
  maxPayloadBytes: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  maxHops: number;
  rateLimitPerMinute: number;
}

const DEFAULT_ALLOWED_KINDS: AgentNetworkMessageKind[] = ["request", "response", "event", "delegation"];
const DEFAULT_ALLOWED_SCOPES = ["task.coordination", "agent.delegation.execute", "agent.delegation.response"];

export const DEFAULT_NETWORK_POLICY: Omit<AgentNetworkPolicy, "organizationId"> = {
  enabled: true,
  allowDelegation: true,
  allowedMessageTypes: DEFAULT_ALLOWED_KINDS,
  allowedScopes: DEFAULT_ALLOWED_SCOPES,
  maxDelegationDepth: 2,
  maxPayloadBytes: 64 * 1024,
  defaultTtlSeconds: 300,
  maxTtlSeconds: 3600,
  maxHops: 4,
  rateLimitPerMinute: 120,
};

export function scopeMatches(allowedScopes: string[], scope: string): boolean {
  return allowedScopes.some((allowed) => allowed === "*" || allowed === scope || (allowed.endsWith(".*") && scope.startsWith(allowed.slice(0, -1))));
}

export function assertNetworkPolicy(
  policy: AgentNetworkPolicy,
  input: { kind: AgentNetworkMessageKind; scope: string; payloadBytes: number; ttlSeconds: number; delegationDepth?: number; hopCount?: number },
) {
  if (!policy.enabled) throw new Error("Agent network is disabled by organization policy");
  if (!policy.allowedMessageTypes.includes(input.kind)) throw new Error("Network message type is blocked by organization policy");
  if (!scopeMatches(policy.allowedScopes, input.scope)) throw new Error("Network scope is blocked by organization policy");
  if (input.payloadBytes < 1 || input.payloadBytes > policy.maxPayloadBytes) throw new Error("Network payload exceeds organization policy");
  if (input.ttlSeconds < 10 || input.ttlSeconds > policy.maxTtlSeconds) throw new Error("Network TTL exceeds organization policy");
  if (input.kind === "delegation") {
    if (!policy.allowDelegation) throw new Error("Autonomous delegation is disabled by organization policy");
    if (!/^agent\.delegation(?:\.|$)/.test(input.scope)) throw new Error("Delegation requires an agent.delegation scope");
    const depth = input.delegationDepth ?? 0;
    if (depth > policy.maxDelegationDepth) throw new Error("Delegation depth exceeds organization policy");
  }
  if ((input.hopCount ?? 0) > policy.maxHops) throw new Error("Network hop limit exceeded");
}

export function normalizeNetworkPolicy(input: Partial<AgentNetworkPolicy> & { organizationId: string }): AgentNetworkPolicy {
  const maxPayloadBytes = Math.min(64 * 1024, Math.max(1024, Math.round(Number(input.maxPayloadBytes ?? DEFAULT_NETWORK_POLICY.maxPayloadBytes))));
  const maxTtlSeconds = Math.min(3600, Math.max(10, Math.round(Number(input.maxTtlSeconds ?? DEFAULT_NETWORK_POLICY.maxTtlSeconds))));
  const defaultTtlSeconds = Math.min(maxTtlSeconds, Math.max(10, Math.round(Number(input.defaultTtlSeconds ?? DEFAULT_NETWORK_POLICY.defaultTtlSeconds))));
  const maxDelegationDepth = Math.min(6, Math.max(0, Math.round(Number(input.maxDelegationDepth ?? DEFAULT_NETWORK_POLICY.maxDelegationDepth))));
  const maxHops = Math.min(12, Math.max(1, Math.round(Number(input.maxHops ?? DEFAULT_NETWORK_POLICY.maxHops))));
  const rateLimitPerMinute = Math.min(600, Math.max(1, Math.round(Number(input.rateLimitPerMinute ?? DEFAULT_NETWORK_POLICY.rateLimitPerMinute))));
  return {
    organizationId: input.organizationId,
    enabled: input.enabled ?? DEFAULT_NETWORK_POLICY.enabled,
    allowDelegation: input.allowDelegation ?? DEFAULT_NETWORK_POLICY.allowDelegation,
    allowedMessageTypes: (input.allowedMessageTypes?.length ? input.allowedMessageTypes : DEFAULT_NETWORK_POLICY.allowedMessageTypes).slice(0, 4),
    allowedScopes: (input.allowedScopes?.length ? input.allowedScopes : DEFAULT_NETWORK_POLICY.allowedScopes).slice(0, 64),
    maxDelegationDepth,
    maxPayloadBytes,
    defaultTtlSeconds,
    maxTtlSeconds,
    maxHops,
    rateLimitPerMinute,
  };
}
