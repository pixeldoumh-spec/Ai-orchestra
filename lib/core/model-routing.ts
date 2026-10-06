export type ModelRouteRole =
  | "planner"
  | "research"
  | "analysis"
  | "writer"
  | "verifier"
  | "agent";

export type ModelCapability =
  | "reasoning"
  | "tools"
  | "vision"
  | "long_context"
  | "coding";

export type ModelReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type ModelReasoningMode = ModelReasoningEffort | "max";

export interface ModelProfile {
  id: string;
  family: string;
  contextWindow: number;
  reasoningModes: ModelReasoningMode[];
  capabilities: ModelCapability[];
  inputCostUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  outputCostUsdPerMillion: number | null;
  qualityScore: number;
  latencyScore: number;
  costScore: number;
  priority: number;
  paid: boolean;
}

export interface RoutingPolicy {
  allowPaidModels: boolean;
  allowlist?: string[];
  preferred?: string[];
  maxCandidates: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
}

export interface ModelSelectionInput {
  role: ModelRouteRole;
  goal?: string;
  objective?: string;
  agentCapabilities?: string[];
  requiredCapabilities?: ModelCapability[];
  toolCount?: number;
  estimatedInputTokens?: number;
  reasoningEffort?: ModelReasoningEffort | null;
  explicitModel?: string | null;
  policy?: Partial<RoutingPolicy>;
}

export interface ModelSelection {
  model: string;
  role: ModelRouteRole;
  candidates: Array<{
    model: string;
    score: number;
    capabilities: ModelCapability[];
    paid: boolean;
  }>;
  reason: string;
}

const CATALOG: ModelProfile[] = [
  {
    id: "@cf/zai-org/glm-5.3-flash",
    family: "GLM 5.3 Flash",
    contextWindow: 1_310_720,
    reasoningModes: ["low", "high", "max"],
    capabilities: ["reasoning", "tools", "vision", "long_context", "coding"],
    inputCostUsdPerMillion: 0.15,
    cachedInputUsdPerMillion: 0.03,
    outputCostUsdPerMillion: 0.5,
    qualityScore: 96,
    latencyScore: 93,
    costScore: 96,
    priority: 100,
    paid: true,
  },
  {
    id: "@cf/deepseek-ai/deepseek-v4-flash-0731",
    family: "DeepSeek V4 Flash",
    contextWindow: 1_048_576,
    reasoningModes: ["none", "low", "high", "max"],
    capabilities: ["reasoning", "tools", "long_context", "coding"],
    inputCostUsdPerMillion: 0.44,
    cachedInputUsdPerMillion: 0.014,
    outputCostUsdPerMillion: 1.32,
    qualityScore: 93,
    latencyScore: 86,
    costScore: 84,
    priority: 90,
    paid: true,
  },
  {
    id: "@cf/deepseek-ai/deepseek-v4-pro-0813",
    family: "DeepSeek V4 Pro",
    contextWindow: 1_048_576,
    reasoningModes: ["low", "high", "max"],
    capabilities: ["reasoning", "tools", "vision", "long_context", "coding"],
    inputCostUsdPerMillion: 1.32,
    cachedInputUsdPerMillion: 0.044,
    outputCostUsdPerMillion: 3.96,
    qualityScore: 98,
    latencyScore: 72,
    costScore: 45,
    priority: 95,
    paid: true,
  },
  {
    id: "@cf/moonshotai/kimi-k2.7-code",
    family: "Kimi K2.7 Code",
    contextWindow: 262_144,
    reasoningModes: ["high"],
    capabilities: ["reasoning", "tools", "vision", "long_context", "coding"],
    inputCostUsdPerMillion: 0.95,
    cachedInputUsdPerMillion: 0.19,
    outputCostUsdPerMillion: 4,
    qualityScore: 97,
    latencyScore: 78,
    costScore: 58,
    priority: 94,
    paid: true,
  },
  {
    id: "@cf/qwen/qwen3.8-27b",
    family: "Qwen 3.8 27B",
    contextWindow: 262_144,
    reasoningModes: ["low", "medium", "xhigh"],
    capabilities: ["reasoning", "tools", "vision", "long_context", "coding"],
    inputCostUsdPerMillion: 0.45,
    cachedInputUsdPerMillion: 0.05,
    outputCostUsdPerMillion: 3.2,
    qualityScore: 89,
    latencyScore: 90,
    costScore: 90,
    priority: 88,
    paid: false,
  },
  {
    id: "@cf/openai/gpt-oss-20b",
    family: "GPT-OSS 20B",
    contextWindow: 128_000,
    reasoningModes: ["low", "medium", "high"],
    capabilities: ["reasoning", "tools", "coding"],
    inputCostUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0,
    outputCostUsdPerMillion: 0.3,
    qualityScore: 76,
    latencyScore: 94,
    costScore: 98,
    priority: 80,
    paid: false,
  },
  {
    id: "@cf/zai-org/glm-4.7-flash",
    family: "GLM 4.7 Flash",
    contextWindow: 131_072,
    reasoningModes: ["low", "medium"],
    capabilities: ["reasoning", "tools", "coding"],
    inputCostUsdPerMillion: null,
    cachedInputUsdPerMillion: null,
    outputCostUsdPerMillion: null,
    qualityScore: 80,
    latencyScore: 92,
    costScore: 94,
    priority: 70,
    paid: false,
  },
];

const DEFAULT_POLICY: RoutingPolicy = {
  allowPaidModels: false,
  maxCandidates: 5,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 30_000,
};

type CircuitState = {
  failures: number;
  openedUntil: number;
  lastError?: string;
};

const circuits = new Map<string, CircuitState>();

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function mergedPolicy(policy?: Partial<RoutingPolicy>): RoutingPolicy {
  return {
    ...DEFAULT_POLICY,
    ...policy,
    allowlist: policy?.allowlist ? normalizeList(policy.allowlist) : undefined,
    preferred: policy?.preferred ? normalizeList(policy.preferred) : undefined,
    maxCandidates: Math.min(16, Math.max(1, Math.floor(policy?.maxCandidates ?? DEFAULT_POLICY.maxCandidates))),
    circuitFailureThreshold: Math.max(1, Math.floor(policy?.circuitFailureThreshold ?? DEFAULT_POLICY.circuitFailureThreshold)),
    circuitCooldownMs: Math.max(1_000, Math.floor(policy?.circuitCooldownMs ?? DEFAULT_POLICY.circuitCooldownMs)),
  };
}

function isCircuitOpen(model: string, now = Date.now()): boolean {
  const state = circuits.get(model);
  if (!state) return false;
  if (state.openedUntil <= now) {
    circuits.delete(model);
    return false;
  }
  return state.failures >= 1;
}

export function recordModelSuccess(model: string): void {
  circuits.delete(model);
}

export function recordModelFailure(model: string, error?: string, policy?: Partial<RoutingPolicy>): void {
  const resolved = mergedPolicy(policy);
  const previous = circuits.get(model);
  const failures = (previous?.failures ?? 0) + 1;
  circuits.set(model, {
    failures,
    openedUntil: failures >= resolved.circuitFailureThreshold
      ? Date.now() + resolved.circuitCooldownMs
      : 0,
    lastError: error?.slice(0, 240),
  });
}

export function resetModelCircuits(): void {
  circuits.clear();
}

export function getModelCatalog(): ModelProfile[] {
  return CATALOG.map((model) => ({
    ...model,
    capabilities: [...model.capabilities],
    reasoningModes: [...model.reasoningModes],
  }));
}

function detectCapabilities(input: ModelSelectionInput): ModelCapability[] {
  const text = [input.goal, input.objective, ...(input.agentCapabilities ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const capabilities = new Set<ModelCapability>(input.requiredCapabilities ?? []);

  if ((input.toolCount ?? 0) > 0) capabilities.add("tools");
  if (/(image|vision|visual|screenshot|photo|diagram|multimodal)/i.test(text)) capabilities.add("vision");
  if (/(code|coding|program|programming|repository|repo|debug|typescript|javascript|python|sql|api implementation|refactor)/i.test(text)) {
    capabilities.add("coding");
  }
  if ((input.estimatedInputTokens ?? 0) > 80_000 || text.length > 320_000) {
    capabilities.add("long_context");
  }
  if (["planner", "analysis", "verifier"].includes(input.role)) capabilities.add("reasoning");
  return [...capabilities];
}

function roleWeights(role: ModelRouteRole, needs: Set<ModelCapability>) {
  const base = {
    quality: 0.28,
    latency: 0.2,
    cost: 0.24,
    capability: 0.18,
    context: 0.1,
  };
  if (role === "planner") return { quality: 0.44, latency: 0.08, cost: 0.14, capability: 0.18, context: 0.16 };
  if (role === "analysis") return { quality: 0.42, latency: 0.1, cost: 0.14, capability: 0.18, context: 0.16 };
  if (role === "verifier") return { quality: 0.5, latency: 0.08, cost: 0.12, capability: 0.14, context: 0.16 };
  if (role === "research") return { quality: 0.25, latency: 0.25, cost: 0.18, capability: 0.22, context: 0.1 };
  if (role === "writer") return { quality: 0.3, latency: 0.25, cost: 0.28, capability: 0.08, context: 0.09 };
  if (needs.has("coding")) return { quality: 0.38, latency: 0.16, cost: 0.18, capability: 0.22, context: 0.06 };
  return base;
}

function capabilityScore(model: ModelProfile, required: Set<ModelCapability>): number {
  if (required.size === 0) return 100;
  const matched = [...required].filter((capability) => model.capabilities.includes(capability)).length;
  return (matched / required.size) * 100;
}

function scoreModel(model: ModelProfile, input: ModelSelectionInput, needs: Set<ModelCapability>, policy: RoutingPolicy): number {
  const weights = roleWeights(input.role, needs);
  const contextScore = (input.estimatedInputTokens ?? 0) <= 0
    ? 100
    : Math.min(100, (model.contextWindow / Math.max(1, input.estimatedInputTokens ?? 0)) * 100);
  const preferredBonus = policy.preferred?.includes(model.id) ? 12 : 0;
  const explicitBonus = input.explicitModel === model.id ? 30 : 0;
  const reasoningPenalty = input.reasoningEffort && !model.reasoningModes.includes(input.reasoningEffort)
    ? -8
    : 0;
  const codingBonus = needs.has("coding") && model.id === "@cf/moonshotai/kimi-k2.7-code" ? 15 : 0;
  const longContextBonus = needs.has("long_context") && model.contextWindow >= 1_000_000 ? 8 : 0;
  return (
    model.qualityScore * weights.quality +
    model.latencyScore * weights.latency +
    model.costScore * weights.cost +
    capabilityScore(model, needs) * weights.capability +
    contextScore * weights.context +
    model.priority * 0.03 +
    codingBonus +
    longContextBonus +
    preferredBonus +
    explicitBonus +
    reasoningPenalty
  );
}

function humanReason(input: ModelSelectionInput, selected: ModelProfile, needs: ModelCapability[], policy: RoutingPolicy): string {
  const reasons: string[] = [];
  reasons.push(`role=${input.role}`);
  if (needs.length) reasons.push(`capabilities=${needs.join(",")}`);
  if (selected.contextWindow >= 1_000_000) reasons.push("ultra-long-context");
  if (selected.paid) reasons.push("paid-model-allowed");
  if (policy.preferred?.includes(selected.id)) reasons.push("preferred");
  if (input.explicitModel === selected.id) reasons.push("explicit-agent-model");
  return reasons.join(";");
}

export function selectModel(input: ModelSelectionInput): ModelSelection {
  const policy = mergedPolicy(input.policy);
  const needs = new Set(detectCapabilities(input));
  const allowlist = policy.allowlist;
  const now = Date.now();
  let candidates = CATALOG.filter((model) => {
    if (!policy.allowPaidModels && model.paid) return false;
    if (allowlist && allowlist.length > 0 && !allowlist.includes(model.id)) return false;
    if (isCircuitOpen(model.id, now)) return false;
    if (model.contextWindow < (input.estimatedInputTokens ?? 0)) return false;
    if (![...needs].every((capability) => model.capabilities.includes(capability))) return false;
    return true;
  });

  if (candidates.length === 0) {
    candidates = CATALOG.filter((model) => {
      if (!policy.allowPaidModels && model.paid) return false;
      if (allowlist && allowlist.length > 0 && !allowlist.includes(model.id)) return false;
      if (isCircuitOpen(model.id, now)) return false;
      return model.contextWindow >= (input.estimatedInputTokens ?? 0);
    });
  }

  if (candidates.length === 0) {
    throw new Error("No routable model satisfies the current model-routing policy");
  }

  const scored = candidates
    .map((model) => ({
      model,
      score: scoreModel(model, input, needs, policy),
    }))
    .sort((a, b) => b.score - a.score || b.model.priority - a.model.priority || a.model.id.localeCompare(b.model.id));

  const selected = scored[0].model;
  return {
    model: selected.id,
    role: input.role,
    candidates: scored.slice(0, policy.maxCandidates).map(({ model, score }) => ({
      model: model.id,
      score: Number(score.toFixed(2)),
      capabilities: [...model.capabilities],
      paid: model.paid,
    })),
    reason: humanReason(input, selected, [...needs], policy),
  };
}
