import { CloudflareWorkersAIAdapter } from "./cloudflare-workers-ai";
import type {
  ModelAdapter,
  ModelCitation,
  ModelCompleteInput,
  ModelFunctionCall,
  ModelResult,
  ModelTool,
  ModelRouteRole,
} from "./types";
import {
  getModelCatalog,
  recordModelFailure,
  recordModelSuccess,
  selectModel,
  type ModelCapability,
} from "@/lib/core/model-routing";

type Pricing = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

const MODEL_PRICING: Array<{ prefix: string; pricing: Pricing }> = [
  {
    prefix: "gpt-5.5",
    pricing: { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 },
  },
  {
    prefix: "gpt-5.4-mini",
    pricing: { inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 },
  },
  {
    prefix: "gpt-5.4",
    pricing: { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  },
];

function positiveEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function pricingForModel(model: string): Pricing {
  const match = MODEL_PRICING.find((entry) => model === entry.prefix || model.startsWith(entry.prefix + "-"));
  if (match) {
    return {
      inputUsdPerMillion: positiveEnvNumber("AI_INPUT_USD_PER_MILLION", match.pricing.inputUsdPerMillion),
      cachedInputUsdPerMillion: positiveEnvNumber("AI_CACHED_INPUT_USD_PER_MILLION", match.pricing.cachedInputUsdPerMillion),
      outputUsdPerMillion: positiveEnvNumber("AI_OUTPUT_USD_PER_MILLION", match.pricing.outputUsdPerMillion),
    };
  }

  return {
    inputUsdPerMillion: positiveEnvNumber("AI_INPUT_USD_PER_MILLION", 0),
    cachedInputUsdPerMillion: positiveEnvNumber("AI_CACHED_INPUT_USD_PER_MILLION", 0),
    outputUsdPerMillion: positiveEnvNumber("AI_OUTPUT_USD_PER_MILLION", 0),
  };
}

function estimateCents(model: string, inputTokens: number, cachedInputTokens: number, outputTokens: number): number {
  const pricing = pricingForModel(model);
  const cached = Math.min(Math.max(0, cachedInputTokens), Math.max(0, inputTokens));
  const uncached = Math.max(0, inputTokens - cached);
  const usd =
    (uncached / 1_000_000) * pricing.inputUsdPerMillion +
    (cached / 1_000_000) * pricing.cachedInputUsdPerMillion +
    (outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return Math.ceil(usd * 100);
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractOutputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { type?: unknown; content?: unknown };
    if (candidate.type !== "message" || !Array.isArray(candidate.content)) continue;
    for (const part of candidate.content) {
      if (!part || typeof part !== "object") continue;
      const piece = part as { type?: unknown; text?: unknown };
      if (piece.type === "output_text" && typeof piece.text === "string") parts.push(piece.text);
    }
  }
  return parts.join("\n");
}

function extractCitations(output: unknown): ModelCitation[] {
  if (!Array.isArray(output)) return [];
  const citations: ModelCitation[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { type?: unknown; content?: unknown; action?: unknown; results?: unknown };
    if (candidate.type === "message" && Array.isArray(candidate.content)) {
      for (const part of candidate.content) {
        if (!part || typeof part !== "object") continue;
        const contentPart = part as { annotations?: unknown };
        if (!Array.isArray(contentPart.annotations)) continue;
        for (const annotation of contentPart.annotations) {
          if (!annotation || typeof annotation !== "object") continue;
          const a = annotation as {
            type?: unknown;
            url_citation?: { url?: unknown; title?: unknown; start_index?: unknown; end_index?: unknown };
            file_citation?: { file_id?: unknown; filename?: unknown; index?: unknown };
          };
          if (a.type === "url_citation" && a.url_citation?.url) {
            citations.push({
              kind: "url",
              url: String(a.url_citation.url),
              title: typeof a.url_citation.title === "string" ? a.url_citation.title : undefined,
              startIndex: Number.isFinite(Number(a.url_citation.start_index)) ? Number(a.url_citation.start_index) : undefined,
              endIndex: Number.isFinite(Number(a.url_citation.end_index)) ? Number(a.url_citation.end_index) : undefined,
            });
          }
          if (a.type === "file_citation" && a.file_citation?.file_id) {
            citations.push({
              kind: "file",
              fileId: String(a.file_citation.file_id),
              filename: typeof a.file_citation.filename === "string" ? a.file_citation.filename : undefined,
              startIndex: Number.isFinite(Number(a.file_citation.index)) ? Number(a.file_citation.index) : undefined,
            });
          }
        }
      }
    }
    if (candidate.type === "web_search_call" && candidate.action && typeof candidate.action === "object") {
      const action = candidate.action as { sources?: unknown };
      if (Array.isArray(action.sources)) {
        for (const source of action.sources) {
          if (!source || typeof source !== "object") continue;
          const s = source as { url?: unknown; title?: unknown; snippet?: unknown };
          if (typeof s.url === "string") {
            citations.push({
              kind: "url",
              url: s.url,
              title: typeof s.title === "string" ? s.title : undefined,
              excerpt: typeof s.snippet === "string" ? s.snippet.slice(0, 4000) : undefined,
            });
          }
        }
      }
    }
    if (candidate.type === "file_search_call" && Array.isArray(candidate.results)) {
      for (const result of candidate.results) {
        if (!result || typeof result !== "object") continue;
        const file = result as { file_id?: unknown; filename?: unknown; text?: unknown; score?: unknown; content?: unknown };
        const text = typeof file.text === "string"
          ? file.text
          : typeof file.content === "string"
            ? file.content
            : undefined;
        if (typeof file.file_id === "string") {
          citations.push({
            kind: "file",
            fileId: file.file_id,
            filename: typeof file.filename === "string" ? file.filename : undefined,
            excerpt: text?.slice(0, 4000),
            score: Number.isFinite(Number(file.score)) ? Number(file.score) : undefined,
          });
        }
      }
    }
  }
  return citations;
}

function extractFunctionCalls(output: unknown): ModelFunctionCall[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
    if (candidate.type !== "function_call") return [];
    if (typeof candidate.call_id !== "string" || typeof candidate.name !== "string" || typeof candidate.arguments !== "string") return [];
    return [{ callId: candidate.call_id, name: candidate.name, arguments: candidate.arguments }];
  });
}

function redactProviderError(status: number, body: unknown): Error {
  let message = `Model provider error (${status})`;
  if (status === 401) message = "Model provider authentication failed";
  else if (status === 403) message = "Model provider request was forbidden";
  else if (status === 429) message = "Model provider rate limit reached";
  else if (body && typeof body === "object") {
    const error = (body as { error?: { code?: unknown } }).error;
    if (error?.code === "insufficient_quota") message = "Model provider quota is exhausted";
  }
  return new Error(message);
}

export class MockModelAdapter implements ModelAdapter {
  readonly provider = "mock";

  supportsTool(_type: ModelTool["type"]): boolean {
    return true;
  }
  async complete(input: ModelCompleteInput): Promise<ModelResult> {
    if (input.system.includes("Verifier Agent")) {
      const output = {
        passed: true,
        confidence: 0.95,
        findings: [],
        evidence: ["Mock verifier completed a structural verification pass."],
      };
      return {
        output,
        outputText: JSON.stringify(output),
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        usageCents: 0,
        status: "completed",
        responseItems: [],
        functionCalls: [],
      };
    }

    return {
      output: `Completed: ${(input.user ?? "").slice(0, 1000)}`,
      outputText: `Completed: ${(input.user ?? "").slice(0, 1000)}`,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      usageCents: 0,
      status: "completed",
      responseItems: [],
      functionCalls: [],
    };
  }
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  readonly provider = "openai";

  supportsTool(_type: ModelTool["type"]): boolean {
    return true;
  }
  async complete(input: ModelCompleteInput): Promise<ModelResult> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not configured");

    const model = input.model || process.env.OPENAI_MODEL || "gpt-5.4-mini";
    const maxOutputTokens = Math.min(
      16_384,
      Math.max(256, Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? "4096")),
    );
    const timeoutMs = Math.min(
      120_000,
      Math.max(10_000, Number(process.env.OPENAI_TIMEOUT_MS ?? "45_000")),
    );
    const effort = input.reasoningEffort ?? "medium";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body: Record<string, unknown> = {
        model,
        instructions: input.system,
        input: input.inputItems ?? [{ role: "user", content: input.user ?? "" }],
        store: false,
        max_output_tokens: maxOutputTokens,
        reasoning: { effort },
        text: {
          verbosity: input.verbosity ?? "medium",
          ...(input.outputSchema
            ? {
                format: {
                  type: "json_schema",
                  name: input.outputSchema.name,
                  strict: true,
                  schema: input.outputSchema.schema,
                },
              }
            : {}),
        },
      };

      if (input.tools && input.tools.length > 0) body.tools = input.tools;
      const include: string[] = [];
      if (input.tools?.some((tool) => tool.type === "file_search")) {
        include.push("file_search_call.results");
      }
      if (input.tools?.some((tool) => tool.type === "web_search")) {
        include.push("web_search_call.action.sources");
      }
      if (include.length > 0) body.include = include;

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const responseBody = await response.json().catch(() => null);
      if (!response.ok) throw redactProviderError(response.status, responseBody);

      const status = typeof responseBody?.status === "string" ? responseBody.status : "unknown";
      if (status !== "completed") {
        const reason =
          typeof responseBody?.incomplete_details?.reason === "string"
            ? responseBody.incomplete_details.reason
            : "unknown";
        throw new Error(`Model response incomplete (${status}; ${reason})`);
      }

      const output = Array.isArray(responseBody?.output) ? responseBody.output : [];
      const outputText =
        typeof responseBody?.output_text === "string"
          ? responseBody.output_text
          : extractOutputText(output);
      const functionCalls = extractFunctionCalls(output);
      const citations = extractCitations(output);
      const inputTokens = Number(responseBody?.usage?.input_tokens ?? 0);
      const cachedInputTokens = Number(
        responseBody?.usage?.input_tokens_details?.cached_tokens ??
          responseBody?.usage?.input_token_details?.cached_tokens ??
          0,
      );
      const outputTokens = Number(responseBody?.usage?.output_tokens ?? 0);
      const usageCents = estimateCents(model, inputTokens, cachedInputTokens, outputTokens);
      const structured = input.outputSchema ? parseJsonText(outputText) : null;

      if (input.outputSchema && structured === null && functionCalls.length === 0) {
        throw new Error(`Structured model output ${input.outputSchema.name} could not be parsed`);
      }

      return {
        output: input.outputSchema ? structured : outputText,
        outputText,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        usageCents,
        responseId: typeof responseBody?.id === "string" ? responseBody.id : undefined,
        responseItems: output,
        functionCalls,
        model: typeof responseBody?.model === "string" ? responseBody.model : model,
        status,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Model provider request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}



function normalizeProvider(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function truthyEnv(name: string, fallback = false): boolean {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return !["false", "0", "no", "off"].includes(value);
}

function csvEnv(name: string): string[] {
  return [...new Set((process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
}

function routingPolicy() {
  return {
    allowPaidModels: truthyEnv("AI_ROUTING_ALLOW_PAID_MODELS", false),
    allowlist: csvEnv("AI_ROUTING_MODEL_ALLOWLIST"),
    preferred: [
      process.env.AI_PLANNER_MODEL,
      process.env.AI_VERIFIER_MODEL,
      process.env.WORKERS_AI_MODEL,
    ].filter((value): value is string => Boolean(value?.trim())),
    maxCandidates: Number(process.env.AI_ROUTING_MAX_CANDIDATES ?? "5"),
    circuitFailureThreshold: Number(process.env.AI_ROUTING_CIRCUIT_FAILURES ?? "2"),
    circuitCooldownMs: Number(process.env.AI_ROUTING_CIRCUIT_COOLDOWN_SECONDS ?? "30") * 1000,
  };
}

function modelRole(input: ModelCompleteInput): ModelRouteRole {
  return input.routingRole ?? "agent";
}

function inferredRoutingCapabilities(input: ModelCompleteInput): ModelCapability[] {
  const context = input.routingContext;
  const capabilities = new Set<ModelCapability>();

  if ((context?.toolCount ?? input.tools?.length ?? 0) > 0) capabilities.add("tools");
  const text = [context?.goal, context?.objective, ...(context?.agentCapabilities ?? [])].filter(Boolean).join(" ");
  if (/(image|vision|visual|screenshot|photo|diagram|multimodal)/i.test(text)) capabilities.add("vision");
  if (/(code|coding|program|programming|repository|repo|debug|typescript|javascript|python|sql|api implementation|refactor)/i.test(text)) {
    capabilities.add("coding");
  }
  if ((context?.estimatedInputTokens ?? 0) > 80_000 || text.length > 320_000) capabilities.add("long_context");
  if (["planner", "analysis", "verifier"].includes(modelRole(input))) capabilities.add("reasoning");
  return [...capabilities];
}

export function selectModelForInput(input: {
  role: ModelRouteRole;
  goal?: string;
  objective?: string;
  agentCapabilities?: string[];
  toolCount?: number;
  estimatedInputTokens?: number;
  reasoningEffort?: ModelCompleteInput["reasoningEffort"];
  explicitModel?: string | null;
}) {
  const policy = routingPolicy();
  const mode = (process.env.AI_ROUTING_MODE ?? "dynamic").trim().toLowerCase();
  const catalog = getModelCatalog();
  const allowPaid = policy.allowPaidModels;
  const explicit = input.explicitModel?.trim() || null;

  if (mode === "pinned" && explicit?.startsWith("@cf/")) {
    const profile = catalog.find((item) => item.id === explicit);
    if (profile && (allowPaid || !profile.paid) && !policy.allowlist?.length || (profile && policy.allowlist?.includes(explicit))) {
      return {
        model: explicit,
        role: input.role,
        candidates: [{ model: explicit, score: 10_000, capabilities: profile.capabilities, paid: profile.paid }],
        reason: `role=${input.role};pinned`,
      };
    }
  }

  return selectModel({
    ...input,
    explicitModel: explicit,
    policy,
  });
}

function dynamicFallbackCandidates(input: ModelCompleteInput, primaryModel: string | null): Array<{ provider: string; model: string }> {
  const role = modelRole(input);
  const selection = selectModelForInput({
    role,
    goal: input.routingContext?.goal,
    objective: input.routingContext?.objective,
    agentCapabilities: input.routingContext?.agentCapabilities,
    toolCount: input.routingContext?.toolCount ?? input.tools?.length,
    estimatedInputTokens: input.routingContext?.estimatedInputTokens,
    reasoningEffort: input.reasoningEffort,
    explicitModel: null,
  });
  const max = Math.min(3, Math.max(0, Number(process.env.AI_ROUTING_MAX_FALLBACKS ?? "2")));
  const configured = (process.env.AI_FALLBACK_MODEL ?? "").trim();
  const output: Array<{ provider: string; model: string }> = [];
  if (configured && configured.startsWith("@cf/") && configured !== primaryModel) {
    output.push({ provider: normalizeProvider(process.env.AI_FALLBACK_PROVIDER) || "workers_ai", model: configured });
  }
  for (const candidate of selection.candidates) {
    if (output.length >= max) break;
    if (candidate.model === primaryModel || output.some((entry) => entry.model === candidate.model)) continue;
    output.push({ provider: "workers_ai", model: candidate.model });
  }
  return output;
}


function isFallbackEligible(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /timeout|timed out|capacity|busy|429|rate limit|quota|allocation|provider error|temporarily unavailable|forbidden|authentication failed|paid plan|required|structured model output|could not be parsed|structured output|contract/i.test(message);
}

function fallbackReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "provider failure");
  return message.slice(0, 240);
}

class FallbackModelAdapter implements ModelAdapter {
  readonly provider?: string;
  private readonly primary: ModelAdapter;
  private readonly configuredFallbacks: Array<{ provider: string; model: string }>;
  private readonly runtimeEnv?: unknown;

  constructor(
    primary: ModelAdapter,
    configuredFallbacks: Array<{ provider: string; model: string }>,
    runtimeEnv?: unknown,
  ) {
    this.primary = primary;
    this.configuredFallbacks = configuredFallbacks;
    this.runtimeEnv = runtimeEnv;
    this.provider = primary.provider;
  }

  supportsTool(type: ModelTool["type"]): boolean {
    return this.primary.supportsTool?.(type) ?? true;
  }

  async complete(input: ModelCompleteInput): Promise<ModelResult> {
    const primaryModel = input.model ?? null;
    try {
      const result = await this.primary.complete(input);
      if (primaryModel) recordModelSuccess(primaryModel);
      return result;
    } catch (error) {
      if (!isFallbackEligible(error)) throw error;
      if (primaryModel) {
        recordModelFailure(primaryModel, fallbackReason(error), {
          circuitFailureThreshold: Number(process.env.AI_ROUTING_CIRCUIT_FAILURES ?? "2"),
          circuitCooldownMs: Number(process.env.AI_ROUTING_CIRCUIT_COOLDOWN_SECONDS ?? "30") * 1000,
        });
      }

      const dynamic = dynamicFallbackCandidates(input, primaryModel);
      const merged: Array<{ provider: string; model: string }> = [];
      for (const candidate of [...this.configuredFallbacks, ...dynamic]) {
        if (candidate.model === primaryModel || merged.some((entry) => entry.model === candidate.model && entry.provider === candidate.provider)) continue;
        merged.push(candidate);
        if (merged.length >= Math.min(3, Math.max(1, Number(process.env.AI_ROUTING_MAX_FALLBACKS ?? "2")))) break;
      }

      let lastError: unknown = error;
      for (const candidate of merged) {
        try {
          const fallback = createProviderAdapter(candidate.provider, this.runtimeEnv);
          const result = await fallback.complete({ ...input, model: candidate.model });
          recordModelSuccess(candidate.model);
          return {
            ...result,
            fallbackFrom: {
              provider: this.primary.provider ?? "unknown",
              model: primaryModel,
              reason: fallbackReason(lastError),
            },
          };
        } catch (fallbackError) {
          recordModelFailure(candidate.model, fallbackReason(fallbackError), {
            circuitFailureThreshold: Number(process.env.AI_ROUTING_CIRCUIT_FAILURES ?? "2"),
            circuitCooldownMs: Number(process.env.AI_ROUTING_CIRCUIT_COOLDOWN_SECONDS ?? "30") * 1000,
          });
          lastError = fallbackError;
        }
      }
      throw lastError;
    }
  }
}

function createProviderAdapter(provider: string, runtimeEnv?: unknown): ModelAdapter {
  if (provider === "openai") return new OpenAIResponsesAdapter();
  if (provider === "cloudflare_workers_ai" || provider === "workers_ai" || provider === "cloudflare-ai") {
    return new CloudflareWorkersAIAdapter(runtimeEnv);
  }
  if (provider === "mock") return new MockModelAdapter();
  throw new Error(`Unsupported AI_MODEL_PROVIDER: ${provider}`);
}

export function getModelAdapter(runtimeEnv?: unknown): ModelAdapter {
  const provider = normalizeProvider(process.env.AI_MODEL_PROVIDER) || "mock";
  const primary = createProviderAdapter(provider, runtimeEnv);

  const fallbackEnabled = truthyEnv("AI_FALLBACK_ENABLED", true);
  if (!fallbackEnabled) return primary;

  const fallbackProvider = normalizeProvider(process.env.AI_FALLBACK_PROVIDER);
  const fallbackModel = process.env.AI_FALLBACK_MODEL?.trim() || "";
  const configuredFallbacks = fallbackProvider && fallbackModel
    ? [{ provider: fallbackProvider, model: fallbackModel }]
    : [];

  if (configuredFallbacks.length === 0 && provider !== "workers_ai" && provider !== "cloudflare_workers_ai" && provider !== "cloudflare-ai") {
    return primary;
  }

  return new FallbackModelAdapter(primary, configuredFallbacks, runtimeEnv);
}

export function getDefaultModel(
  role: "planner" | "agent" | "verifier",
  context?: {
    goal?: string;
    objective?: string;
    agentCapabilities?: string[];
    toolCount?: number;
    estimatedInputTokens?: number;
    reasoningEffort?: ModelCompleteInput["reasoningEffort"];
    explicitModel?: string | null;
  },
): string {
  const provider = (process.env.AI_MODEL_PROVIDER ?? "mock").trim().toLowerCase();
  if (provider === "cloudflare_workers_ai" || provider === "workers_ai" || provider === "cloudflare-ai") {
    const routeRole: ModelRouteRole = role === "planner" ? "planner" : role === "verifier" ? "verifier" : "agent";
    const configured = role === "planner"
      ? process.env.AI_PLANNER_MODEL
      : role === "verifier"
        ? process.env.AI_VERIFIER_MODEL
        : process.env.WORKERS_AI_MODEL ?? process.env.OPENAI_MODEL;
    const decision = selectModelForInput({
      role: routeRole,
      ...context,
      explicitModel: context?.explicitModel ?? null,
    });
    if (decision.model) return decision.model;
    return configured?.startsWith("@cf/") ? configured : "@cf/openai/gpt-oss-20b";
  }

  if (role === "planner") return process.env.AI_PLANNER_MODEL ?? "gpt-5.5";
  if (role === "verifier") return process.env.AI_VERIFIER_MODEL ?? process.env.AI_PLANNER_MODEL ?? "gpt-5.5";
  return process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
}
