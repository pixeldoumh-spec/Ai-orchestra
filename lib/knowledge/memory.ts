import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { indexMemoryForRetrieval, retrieveWorkspaceKnowledge } from "./retrieval";

const MAX_CONTENT = 12000;
const MAX_RESULTS = 50;

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalize(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export type MemoryKind = "fact" | "preference" | "decision" | "procedure" | "context";
export type MemoryVisibility = "workspace" | "private";

export async function createMemory(input: {
  organizationId: string;
  userId: string;
  kind: MemoryKind;
  visibility: MemoryVisibility;
  content: string;
  sourceType?: "user" | "task" | "document" | "agent";
  sourceRef?: string | null;
  confidence?: number;
  importance?: number;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const content = normalize(input.content);
  if (!content || content.length > MAX_CONTENT) throw new Error("Memory content must be 1–12,000 characters");
  if (input.visibility === "private" && !input.userId) throw new Error("Private memory requires an owner");

  const db = createAdminClient();
  const contentSha256 = hash(content);
  const { data: existing, error: duplicateError } = await db
    .from("knowledge_memories")
    .select("id,kind,visibility,content,status,created_at")
    .eq("organization_id", input.organizationId)
    .eq("content_sha256", contentSha256)
    .neq("status", "deleted")
    .or(input.visibility === "private" ? `user_id.eq.${input.userId}` : "user_id.is.null")
    .maybeSingle();
  if (duplicateError) throw new Error(duplicateError.message);
  if (existing) return { duplicate: true, memory: existing };

  const { data, error } = await db
    .from("knowledge_memories")
    .insert({
      organization_id: input.organizationId,
      user_id: input.visibility === "private" ? input.userId : null,
      kind: input.kind,
      visibility: input.visibility,
      content,
      content_sha256: contentSha256,
      source_type: input.sourceType ?? "user",
      source_ref: input.sourceRef ?? null,
      confidence: Math.max(0, Math.min(1, input.confidence ?? 1)),
      importance: Math.max(0, Math.min(100, Math.round(input.importance ?? 50))),
      expires_at: input.expiresAt ?? null,
      metadata: input.metadata ?? {},
    })
    .select("id,kind,visibility,content,source_type,source_ref,confidence,importance,created_at")
    .single();
  if (error) throw new Error(error.message);

  let retrievalReady = true;
  try {
    await indexMemoryForRetrieval({
      organizationId: input.organizationId,
      memoryId: data.id,
      content,
    });
  } catch {
    retrievalReady = false;
  }

  return { duplicate: false, memory: data, retrievalReady };
}

export async function listMemories(organizationId: string, userId: string) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("knowledge_memories")
    .select("id,kind,visibility,content,source_type,source_ref,confidence,importance,expires_at,status,created_at,updated_at")
    .eq("organization_id", organizationId)
    .neq("status", "deleted")
    .or(`visibility.eq.workspace,user_id.eq.${userId}`)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function retrieveKnowledge(input: {
  organizationId: string;
  userId: string;
  query: string;
  limit?: number;
  workspaceOnly?: boolean;
}) {
  const normalized = normalize(input.query);
  if (!normalized) return [];
  return retrieveWorkspaceKnowledge({
    organizationId: input.organizationId,
    userId: input.userId,
    query: normalized,
    limit: Math.max(1, Math.min(MAX_RESULTS, input.limit ?? 8)),
    workspaceOnly: input.workspaceOnly ?? false,
  });
}

export async function retrieveMemories(organizationId: string, userId: string, query: string, limit = 8) {
  const results = await retrieveKnowledge({
    organizationId,
    userId,
    query,
    limit,
    workspaceOnly: false,
  });
  return results.filter((row: any) => row.source_type === "memory");
}

export async function softDeleteMemory(organizationId: string, userId: string, memoryId: string) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("knowledge_memories")
    .update({ status: "deleted", updated_at: new Date().toISOString() })
    .eq("id", memoryId)
    .eq("organization_id", organizationId)
    .or(`user_id.eq.${userId},and(visibility.eq.workspace,user_id.is.null)`)
    .select("id,status")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Memory not found or not accessible");
  await db.from("knowledge_chunks").delete().eq("organization_id", organizationId).eq("memory_id", memoryId);
  return data;
}

export async function recordRetrieval(input: {
  organizationId: string;
  userId: string;
  taskId?: string | null;
  query: string;
  memoryCount: number;
  documentCount: number;
}) {
  const db = createAdminClient();
  const { error } = await db.from("knowledge_retrieval_events").insert({
    organization_id: input.organizationId,
    user_id: input.userId,
    task_id: input.taskId ?? null,
    query_hash: hash(normalize(input.query)),
    result_count: Math.max(0, Math.min(100, input.memoryCount + input.documentCount)),
    memory_count: Math.max(0, Math.min(100, input.memoryCount)),
    document_count: Math.max(0, Math.min(100, input.documentCount)),
  });
  if (error) throw new Error(error.message);
}
