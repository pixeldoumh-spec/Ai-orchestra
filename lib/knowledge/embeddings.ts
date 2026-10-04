import { getCloudflareContext } from "@opennextjs/cloudflare";

type WorkersAI = {
  run(model: string, input: Record<string, unknown>, options?: { rejectIfBusy?: boolean }): Promise<unknown>;
};

const DEFAULT_MODEL = "@cf/baai/bge-base-en-v1.5";
const DIMENSIONS = 768;
const MAX_INPUT_CHARS = 1800;
const BATCH_SIZE = 32;

function getWorkersAI(): WorkersAI {
  const context = getCloudflareContext();
  const ai = (context.env as { AI?: unknown }).AI;
  if (!ai || typeof ai !== "object" || typeof (ai as { run?: unknown }).run !== "function") {
    throw new Error("Cloudflare Workers AI binding is not configured");
  }
  return ai as WorkersAI;
}

function modelName() {
  const configured = process.env.KNOWLEDGE_EMBEDDING_MODEL?.trim();
  return configured?.startsWith("@cf/") ? configured : DEFAULT_MODEL;
}

function normalizeText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function vectorLiteral(values: number[]) {
  if (values.length !== DIMENSIONS) throw new Error(`Knowledge embedding must have ${DIMENSIONS} dimensions`);
  if (!values.every((value) => Number.isFinite(value))) throw new Error("Knowledge embedding contains a non-finite value");
  return "[" + values.map((value) => Number(value).toString()).join(",") + "]";
}

export async function embedTexts(values: string[]): Promise<number[][]> {
  const cleaned = values.map((value) => normalizeText(value).slice(0, MAX_INPUT_CHARS)).filter(Boolean);
  if (cleaned.length === 0) return [];
  const ai = getWorkersAI();
  const results: number[][] = [];
  for (let index = 0; index < cleaned.length; index += BATCH_SIZE) {
    const batch = cleaned.slice(index, index + BATCH_SIZE);
    const response = await ai.run(modelName(), { text: batch, pooling: "cls" }, { rejectIfBusy: true });
    if (!response || typeof response !== "object") throw new Error("Workers AI embedding response is invalid");
    const data = (response as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== batch.length) throw new Error("Workers AI returned an unexpected embedding batch");
    for (const vector of data) {
      if (!Array.isArray(vector) || vector.length !== DIMENSIONS) throw new Error("Workers AI returned an unexpected embedding dimension");
      results.push(vector.map(Number));
    }
  }
  return results;
}

export async function embedText(value: string) {
  const [embedding] = await embedTexts([value]);
  if (!embedding) throw new Error("Workers AI returned no embedding");
  return embedding;
}

export const KNOWLEDGE_EMBEDDING_MODEL = DEFAULT_MODEL;
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = DIMENSIONS;
