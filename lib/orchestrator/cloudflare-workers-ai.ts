import { getCloudflareContext } from "@opennextjs/cloudflare";
import type {
  ModelAdapter,
  ModelCompleteInput,
  ModelFunctionCall,
  ModelResult,
  ModelTool,
} from "./types";

type WorkersAI = {
  run(model: string, input: Record<string, unknown>, options?: { rejectIfBusy?: boolean }): Promise<unknown>;
};

let dailyExhaustedUntil = 0;

const MODEL_DEFAULT = "@cf/openai/gpt-oss-20b";
const MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 45_000;

const NEURON_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  "@cf/openai/gpt-oss-20b": { inputPerMillion: 18_182, outputPerMillion: 27_273 },
  "@cf/openai/gpt-oss-120b": { inputPerMillion: 31_818, outputPerMillion: 68_182 },
};

function endOfUtcDayMs(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function getWorkersAI(runtimeEnv?: unknown): WorkersAI {
  const direct = runtimeEnv && typeof runtimeEnv === "object"
    ? (runtimeEnv as { AI?: unknown }).AI
    : undefined;
  if (direct && typeof direct === "object" && typeof (direct as { run?: unknown }).run === "function") {
    return direct as WorkersAI;
  }
  const context = getCloudflareContext();
  const ai = (context.env as { AI?: unknown }).AI;
  if (!ai || typeof ai !== "object" || typeof (ai as { run?: unknown }).run !== "function") {
    throw new Error("Cloudflare Workers AI binding is not configured");
  }
  return ai as WorkersAI;
}

function modelForInput(input: ModelCompleteInput): string {
  const configured = input.model?.trim();
  if (configured?.startsWith("@cf/")) return configured;
  const envModel = process.env.WORKERS_AI_MODEL?.trim();
  return envModel?.startsWith("@cf/") ? envModel : MODEL_DEFAULT;
}

function maxOutputTokens(): number {
  const value = Number(process.env.WORKERS_AI_MAX_OUTPUT_TOKENS ?? String(MAX_OUTPUT_TOKENS));
  if (!Number.isFinite(value)) return MAX_OUTPUT_TOKENS;
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(128, Math.floor(value)));
}

function timeoutMs(): number {
  const value = Number(process.env.WORKERS_AI_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS));
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(120_000, Math.max(10_000, Math.floor(value)));
}

function normalizeReasoningEffort(effort: ModelCompleteInput["reasoningEffort"]): "low" | "medium" | "high" {
  if (effort === "low" || effort === "high") return effort;
  return "medium";
}

function formatStructuredInstruction(input: ModelCompleteInput): string {
  if (!input.outputSchema) return input.system;
  return [
    input.system,
    "",
    "Structured-output contract:",
    "Return ONLY valid JSON matching the requested schema.",
    JSON.stringify(input.outputSchema.schema),
    "Do not wrap the JSON in markdown fences. Do not add commentary before or after the JSON.",
  ].join("\n");
}

function normalizeInputItems(input: ModelCompleteInput): unknown[] {
  if (input.inputItems?.length) return input.inputItems;
  return [{ role: "user", content: input.user ?? "" }];
}

function normalizeTools(tools: ModelTool[] | undefined): unknown[] {
  return (tools ?? []).filter((tool) => tool.type === "function").map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict,
  }));
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

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

function extractUsage(response: Record<string, unknown>) {
  const usage = response.usage && typeof response.usage === "object"
    ? response.usage as Record<string, unknown>
    : {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cachedInputTokens = Number(
    (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
    0,
  );
  return {
    inputTokens: Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0,
    cachedInputTokens: Number.isFinite(cachedInputTokens) ? Math.max(0, cachedInputTokens) : 0,
    outputTokens: Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0,
  };
}

function estimateNeurons(model: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = NEURON_PRICING[model];
  if (!pricing) return null;
  const neurons =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.ceil(neurons);
}

function responseErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const direct = Number((error as { code?: unknown }).code);
  if (Number.isFinite(direct)) return direct;
  const nested = (error as { errors?: unknown }).errors;
  if (Array.isArray(nested)) {
    const first = nested[0];
    if (first && typeof first === "object") {
      const code = Number((first as { code?: unknown }).code);
      if (Number.isFinite(code)) return code;
    }
  }
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  const match = message.match(/(?:code|error code)[:= ]+(\\d{4})/i);
  return match ? Number(match[1]) : null;
}

function responseErrorMessage(error: unknown): string {
  const code = responseErrorCode(error);
  if (code === 3036) return "Cloudflare Workers AI daily free allocation exhausted";
  if (code === 3040) return "Cloudflare Workers AI capacity is temporarily unavailable";
  if (code === 5035) return "The selected Workers AI model requires a paid plan";
  if (error instanceof Error) return error.message.slice(0, 500);
  return "Cloudflare Workers AI request failed";
}

function isErrorEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { success?: unknown; errors?: unknown };
  return candidate.success === false && Array.isArray(candidate.errors) && candidate.errors.length > 0;
}


function usesChatCompletions(model: string): boolean {
  return model === "@cf/zai-org/glm-4.7-flash";
}

function chatContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const candidate = part as { type?: unknown; text?: unknown };
      return typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeChatMessages(input: ModelCompleteInput): unknown[] {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: formatStructuredInstruction(input) },
  ];

  for (const item of normalizeInputItems(input)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const type = typeof candidate.type === "string" ? candidate.type : "";
    if (type === "message") {
      const content = chatContent(candidate.content);
      if (content) messages.push({ role: "assistant", content });
      continue;
    }
    if (type === "function_call") {
      const callId = typeof candidate.call_id === "string" ? candidate.call_id : crypto.randomUUID();
      const name = typeof candidate.name === "string" ? candidate.name : "unknown";
      const args = typeof candidate.arguments === "string" ? candidate.arguments : "{}";
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: callId,
          type: "function",
          function: { name, arguments: args },
        }],
      });
      continue;
    }
    if (type === "function_call_output") {
      const callId = typeof candidate.call_id === "string" ? candidate.call_id : "";
      const output = typeof candidate.output === "string" ? candidate.output : JSON.stringify(candidate.output ?? null);
      if (callId) messages.push({ role: "tool", tool_call_id: callId, content: output });
      continue;
    }
    const role = candidate.role;
    if (role === "user" || role === "assistant" || role === "tool") {
      const content = chatContent(candidate.content);
      if (role === "tool") {
        const callId = typeof candidate.tool_call_id === "string" ? candidate.tool_call_id : "";
        if (callId) messages.push({ role: "tool", tool_call_id: callId, content });
      } else if (content) {
        messages.push({ role, content });
      }
    }
  }
  return messages;
}

function extractChatResponse(response: Record<string, unknown>) {
  const usage = response.usage && typeof response.usage === "object"
    ? response.usage as Record<string, unknown>
    : {};
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0] && typeof choices[0] === "object"
    ? choices[0] as Record<string, unknown>
    : {};
  const message = first.message && typeof first.message === "object"
    ? first.message as Record<string, unknown>
    : {};
  const outputText = typeof message.content === "string" ? message.content : "";
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const call = item as Record<string, unknown>;
        const fn = call.function && typeof call.function === "object"
          ? call.function as Record<string, unknown>
          : {};
        if (typeof call.id !== "string" || typeof fn.name !== "string") return [];
        const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        return [{ callId: call.id, name: fn.name, arguments: args }];
      })
    : [];
  const items: unknown[] = [];
  if (outputText) items.push({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: outputText }],
  });
  for (const call of toolCalls) {
    items.push({
      type: "function_call",
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
    });
  }
  return {
    outputText,
    functionCalls: toolCalls,
    responseItems: items,
    inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    cachedInputTokens: Number(
      (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
      (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
      0,
    ),
    outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
  };
}

export class CloudflareWorkersAIAdapter implements ModelAdapter {
  readonly provider = "cloudflare_workers_ai";
  private readonly runtimeEnv?: unknown;

  constructor(runtimeEnv?: unknown) {
    this.runtimeEnv = runtimeEnv;
  }

  supportsTool(type: ModelTool["type"]): boolean {
    return type === "function";
  }

  async complete(input: ModelCompleteInput): Promise<ModelResult> {
    if (Date.now() < dailyExhaustedUntil) {
      throw new Error("Cloudflare Workers AI daily free allocation is exhausted; waiting for the next UTC reset");
    }

    const model = modelForInput(input);
    const ai = getWorkersAI(this.runtimeEnv);
    const maxTokens = maxOutputTokens();
    const request: Record<string, unknown> = usesChatCompletions(model)
      ? {
          model,
          messages: normalizeChatMessages(input),
          stream: false,
          max_tokens: maxTokens,
        }
      : {
          model,
          instructions: formatStructuredInstruction(input),
          input: normalizeInputItems(input),
          stream: false,
          max_output_tokens: maxTokens,
          reasoning: { effort: normalizeReasoningEffort(input.reasoningEffort) },
        };

    const tools = normalizeTools(input.tools);
    if (tools.length > 0) request.tools = tools;

    try {
      const result = await Promise.race([
        ai.run(model, request, { rejectIfBusy: true }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Cloudflare Workers AI request timed out after ${timeoutMs()}ms`)), timeoutMs()),
        ),
      ]);

      if (isErrorEnvelope(result)) {
        const code = responseErrorCode(result);
        if (code === 3036) dailyExhaustedUntil = endOfUtcDayMs();
        throw new Error(responseErrorMessage(result));
      }

      if (!result || typeof result !== "object") {
        throw new Error("Cloudflare Workers AI returned an invalid response");
      }

      const response = result as Record<string, unknown>;
      const chat = usesChatCompletions(model);
      const chatParsed = chat ? extractChatResponse(response) : null;
      const output = chat ? (chatParsed?.responseItems ?? []) : (Array.isArray(response.output) ? response.output : []);
      const outputText = chat
        ? (chatParsed?.outputText ?? "")
        : (typeof response.output_text === "string" ? response.output_text : extractOutputText(output));
      const functionCalls = chat
        ? (chatParsed?.functionCalls ?? [])
        : extractFunctionCalls(output);
      const usage = chat ? {
        inputTokens: Number.isFinite(chatParsed?.inputTokens ?? 0) ? Math.max(0, Number(chatParsed?.inputTokens ?? 0)) : 0,
        cachedInputTokens: Number.isFinite(chatParsed?.cachedInputTokens ?? 0) ? Math.max(0, Number(chatParsed?.cachedInputTokens ?? 0)) : 0,
        outputTokens: Number.isFinite(chatParsed?.outputTokens ?? 0) ? Math.max(0, Number(chatParsed?.outputTokens ?? 0)) : 0,
      } : extractUsage(response);
      const structured = input.outputSchema ? parseJsonText(outputText) : null;
      if (input.outputSchema && structured === null && functionCalls.length === 0) {
        throw new Error(`Workers AI structured output ${input.outputSchema.name} could not be parsed`);
      }

      return {
        output: input.outputSchema ? structured : outputText,
        outputText,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        usageCents: 0,
        provider: this.provider,
        resourceUsage: {
          unit: "neurons",
          estimated: estimateNeurons(model, usage.inputTokens, usage.outputTokens),
          actual: typeof (response.usage as Record<string, unknown> | undefined)?.neurons === "number"
            ? Number((response.usage as Record<string, unknown>).neurons)
            : null,
        },
        responseId: typeof response.id === "string" ? response.id : undefined,
        responseItems: output,
        functionCalls,
        model: typeof response.model === "string" ? response.model : model,
        status: typeof response.status === "string" ? response.status : "completed",
      };
    } catch (error) {
      const code = responseErrorCode(error);
      if (code === 3036) dailyExhaustedUntil = endOfUtcDayMs();
      if (code === 3040) {
        throw new Error("Cloudflare Workers AI capacity temporarily unavailable");
      }
      throw new Error(responseErrorMessage(error));
    }
  }
}
