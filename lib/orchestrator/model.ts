import type {
  ModelAdapter,
  ModelCitation,
  ModelCompleteInput,
  ModelFunctionCall,
  ModelResult,
} from "./types";

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

export function getModelAdapter(): ModelAdapter {
  const provider = (process.env.AI_MODEL_PROVIDER ?? "mock").trim().toLowerCase();
  if (provider === "openai") return new OpenAIResponsesAdapter();
  if (provider === "mock") return new MockModelAdapter();
  throw new Error(`Unsupported AI_MODEL_PROVIDER: ${provider}`);
}
