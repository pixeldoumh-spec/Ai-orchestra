import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedText, embedTexts, vectorLiteral } from "./embeddings";

const MAX_LOCAL_TEXT = 2_000_000;
const MAX_CHUNK_CHARS = 1800;
const OVERLAP_CHARS = 240;

const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/html",
  "text/javascript",
  "application/javascript",
  "application/typescript",
  "text/x-python",
  "text/x-java",
  "text/x-c",
  "text/x-c++",
  "text/x-csharp",
  "text/x-golang",
  "text/x-php",
  "text/x-ruby",
  "text/x-shellscript",
]);

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalize(value: string) {
  return value.normalize("NFKC").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

export function isLocallyIndexableMimeType(mimeType: string) {
  return TEXT_MIMES.has(mimeType.toLowerCase());
}

export async function extractIndexableText(file: File, mimeType: string) {
  if (!isLocallyIndexableMimeType(mimeType)) return null;
  const raw = await file.text();
  const normalized = normalize(raw);
  if (!normalized) return null;
  if (mimeType === "text/html") {
    return normalize(normalized.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
  }
  return normalized.slice(0, MAX_LOCAL_TEXT);
}

export function chunkText(value: string) {
  const text = normalize(value).slice(0, MAX_LOCAL_TEXT);
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < 1500) {
    let end = Math.min(text.length, start + MAX_CHUNK_CHARS);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf(". ", end),
        text.lastIndexOf(" ", end),
      );
      if (boundary > start + Math.floor(MAX_CHUNK_CHARS * 0.55)) end = boundary + (text[boundary] === " " ? 1 : 0);
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - OVERLAP_CHARS);
  }
  return chunks;
}

async function embedBatches(chunks: string[]) {
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += 32) {
    vectors.push(...await embedTexts(chunks.slice(i, i + 32)));
  }
  return vectors;
}

export async function indexDocumentForLocalRetrieval(input: {
  organizationId: string;
  documentId: string;
  file: File;
  mimeType: string;
}) {
  const db = createAdminClient();
  const mimeType = input.mimeType.toLowerCase();
  if (!isLocallyIndexableMimeType(mimeType)) {
    await db.from("knowledge_documents").update({
      local_retrieval_status: "unsupported",
      local_chunk_count: 0,
      local_indexed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("organization_id", input.organizationId).eq("id", input.documentId);
    return { status: "unsupported" as const, chunkCount: 0 };
  }

  const extracted = await extractIndexableText(input.file, mimeType);
  if (!extracted) {
    await db.from("knowledge_documents").update({
      local_retrieval_status: "failed",
      local_chunk_count: 0,
      local_indexed_at: null,
      updated_at: new Date().toISOString(),
    }).eq("organization_id", input.organizationId).eq("id", input.documentId);
    return { status: "failed" as const, chunkCount: 0 };
  }

  const chunks = chunkText(extracted);
  if (chunks.length === 0) {
    await db.from("knowledge_documents").update({
      local_retrieval_status: "failed",
      local_chunk_count: 0,
      local_indexed_at: null,
      updated_at: new Date().toISOString(),
    }).eq("organization_id", input.organizationId).eq("id", input.documentId);
    return { status: "failed" as const, chunkCount: 0 };
  }

  await db.from("knowledge_documents").update({
    local_retrieval_status: "indexing",
    updated_at: new Date().toISOString(),
  }).eq("organization_id", input.organizationId).eq("id", input.documentId);

  try {
    await db.from("knowledge_chunks").delete().eq("organization_id", input.organizationId).eq("document_id", input.documentId);
    const vectors = await embedBatches(chunks);
    if (vectors.length !== chunks.length) throw new Error("Embedding count did not match chunk count");

    const rows = chunks.map((chunk, index) => ({
      organization_id: input.organizationId,
      document_id: input.documentId,
      memory_id: null,
      chunk_index: index,
      content: chunk.slice(0, 10000),
      content_sha256: sha256(input.documentId + ":" + index + ":" + chunk),
      embedding: vectorLiteral(vectors[index]),
      metadata: {
        mime_type: mimeType,
        character_start: Math.max(0, index * (MAX_CHUNK_CHARS - OVERLAP_CHARS)),
        character_length: chunk.length,
      },
    }));
    for (let i = 0; i < rows.length; i += 64) {
      const { error } = await db.from("knowledge_chunks").insert(rows.slice(i, i + 64));
      if (error) throw new Error(error.message);
    }

    await db.from("knowledge_documents").update({
      local_retrieval_status: "indexed",
      local_chunk_count: rows.length,
      local_indexed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("organization_id", input.organizationId).eq("id", input.documentId);

    return { status: "indexed" as const, chunkCount: rows.length };
  } catch (error) {
    await db.from("knowledge_documents").update({
      local_retrieval_status: "failed",
      local_chunk_count: 0,
      local_indexed_at: null,
      updated_at: new Date().toISOString(),
    }).eq("organization_id", input.organizationId).eq("id", input.documentId);
    throw error instanceof Error ? error : new Error("Local knowledge indexing failed");
  }
}

export async function indexMemoryForRetrieval(input: {
  organizationId: string;
  memoryId: string;
  content: string;
}) {
  const db = createAdminClient();
  const embedding = await embedText(input.content);
  await db.from("knowledge_chunks").delete().eq("organization_id", input.organizationId).eq("memory_id", input.memoryId);
  const { error } = await db.from("knowledge_chunks").insert({
    organization_id: input.organizationId,
    document_id: null,
    memory_id: input.memoryId,
    chunk_index: 0,
    content: input.content.slice(0, 10000),
    content_sha256: sha256(input.memoryId + ":" + input.content),
    embedding: vectorLiteral(embedding),
    metadata: { source: "workspace_memory" },
  });
  if (error) throw new Error(error.message);
}

export async function retrieveWorkspaceKnowledge(input: {
  organizationId: string;
  userId: string;
  query: string;
  limit?: number;
  workspaceOnly?: boolean;
}) {
  const query = normalize(input.query).slice(0, MAX_CHUNK_CHARS);
  if (!query) return [];
  const db = createAdminClient();
  try {
    const embedding = await embedText(query);
    const { data, error } = await db.rpc("search_workspace_knowledge", {
      p_organization_id: input.organizationId,
      p_user_id: input.userId,
      p_query_embedding: vectorLiteral(embedding),
      p_limit: Math.max(1, Math.min(50, input.limit ?? 8)),
      p_include_private: !input.workspaceOnly,
    });
    if (!error) return data ?? [];
  } catch {
    // Lexical fallback below keeps knowledge retrieval available during embedding/runtime outages.
  }

  const { data: memories, error } = await db.rpc("search_workspace_memory", {
    p_organization_id: input.organizationId,
    p_user_id: input.userId,
    p_query: query,
    p_limit: Math.max(1, Math.min(50, input.limit ?? 8)),
  });
  if (error) throw new Error(error.message);
  return (memories ?? []).map((row: any) => ({
    id: row.id,
    source_type: "memory",
    memory_id: row.id,
    document_id: null,
    filename: null,
    kind: row.kind,
    visibility: row.visibility,
    content: row.content,
    source_ref: row.source_ref,
    confidence: row.confidence,
    importance: row.importance,
    chunk_index: 0,
    score: row.score,
  }));
}
