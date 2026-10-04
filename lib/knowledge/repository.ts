import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ensureKnowledgeVectorStore,
  getVectorStoreFileStatus,
  uploadKnowledgeFile,
  isSupportedKnowledgeMimeType,
} from "./openai";
import { indexDocumentForLocalRetrieval } from "./retrieval";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const BUCKET = "knowledge-documents";

function safeFilename(filename: string) {
  return filename
    .normalize("NFKC")
    .replace(/[/\\]/g, "_")
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim()
    .slice(0, 180) || "document";
}

function sha256(buffer: ArrayBuffer) {
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

function providerName() {
  return (process.env.AI_MODEL_PROVIDER ?? "workers_ai").trim().toLowerCase();
}

export async function listKnowledgeDocuments(organizationId: string) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("knowledge_documents")
    .select("id,filename,mime_type,size_bytes,content_sha256,provider,provider_file_id,provider_vector_store_file_id,status,local_retrieval_status,local_chunk_count,local_indexed_at,error,metadata,created_at,updated_at")
    .eq("organization_id", organizationId)
    .neq("status", "deleted")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getKnowledgeDocument(organizationId: string, documentId: string) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("knowledge_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function ingestKnowledgeDocument(input: {
  organizationId: string;
  createdBy: string;
  file: File;
}) {
  if (input.file.size < 1 || input.file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Document must be between 1 byte and 50 MB");
  }
  const mimeType = (input.file.type || "application/octet-stream").toLowerCase();
  if (!isSupportedKnowledgeMimeType(mimeType)) {
    throw new Error("Unsupported document type. Use PDF, DOCX, PPTX, text, Markdown, CSV, JSON, HTML or supported source-code formats.");
  }

  const bytes = await input.file.arrayBuffer();
  const contentHash = sha256(bytes);
  const filename = safeFilename(input.file.name);
  const db = createAdminClient();
  const runtimeProvider = providerName();

  const { data: duplicate } = await db
    .from("knowledge_documents")
    .select("id,status,filename,provider,local_retrieval_status,local_chunk_count")
    .eq("organization_id", input.organizationId)
    .eq("content_sha256", contentHash)
    .neq("status", "deleted")
    .maybeSingle();
  if (duplicate) return { duplicate: true, document: duplicate };

  const documentId = crypto.randomUUID();
  const storagePath = input.organizationId + "/" + documentId + "/" + filename;
  const { error: storageError } = await db.storage
    .from(BUCKET)
    .upload(storagePath, new Blob([bytes], { type: mimeType }), {
      contentType: mimeType,
      cacheControl: "3600",
      upsert: false,
    });
  if (storageError) throw new Error(storageError.message);

  const { data: document, error: insertError } = await db
    .from("knowledge_documents")
    .insert({
      id: documentId,
      organization_id: input.organizationId,
      filename,
      mime_type: mimeType,
      size_bytes: input.file.size,
      content_sha256: contentHash,
      storage_bucket: BUCKET,
      storage_path: storagePath,
      provider: runtimeProvider === "openai" ? "openai" : "workers_ai_local",
      status: "stored",
      local_retrieval_status: "not_indexed",
      local_chunk_count: 0,
      metadata: { original_filename: input.file.name, ingestion_version: "6.5" },
      created_by: input.createdBy,
    })
    .select("id,filename,mime_type,size_bytes,status,provider,local_retrieval_status,local_chunk_count,created_at")
    .single();

  if (insertError) {
    await db.storage.from(BUCKET).remove([storagePath]);
    throw new Error(insertError.message);
  }

  let localIndex: { status: "indexed" | "unsupported" | "failed"; chunkCount: number } = {
    status: "unsupported",
    chunkCount: 0,
  };
  try {
    localIndex = await indexDocumentForLocalRetrieval({
      organizationId: input.organizationId,
      documentId,
      file: input.file,
      mimeType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local semantic indexing failed";
    await db.from("knowledge_documents").update({
      local_retrieval_status: "failed",
      local_chunk_count: 0,
      error: message.slice(0, 1000),
      updated_at: new Date().toISOString(),
    }).eq("id", documentId).eq("organization_id", input.organizationId);
    localIndex = { status: "failed", chunkCount: 0 };
  }

  if (runtimeProvider !== "openai") {
    const status = localIndex.status === "failed" ? "failed" : "ready";
    await db.from("knowledge_documents").update({
      status,
      error: localIndex.status === "failed" ? "Local semantic indexing failed" : null,
      updated_at: new Date().toISOString(),
    }).eq("id", documentId).eq("organization_id", input.organizationId);
    return {
      duplicate: false,
      document: {
        ...document,
        provider_file_id: null,
        provider_vector_store_file_id: null,
        status,
        local_retrieval_status: localIndex.status,
        local_chunk_count: localIndex.chunkCount,
      },
    };
  }

  try {
    await ensureKnowledgeVectorStore(input.organizationId);
    await db.from("knowledge_documents").update({
      status: "indexing",
      error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", documentId).eq("organization_id", input.organizationId);

    const indexed = await uploadKnowledgeFile({
      organizationId: input.organizationId,
      documentId,
      file: input.file,
      filename,
      mimeType,
    });
    await db.from("knowledge_documents").update({
      provider_file_id: indexed.providerFileId,
      provider_vector_store_file_id: indexed.providerVectorStoreFileId,
      status: indexed.status,
      error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", documentId).eq("organization_id", input.organizationId);

    return {
      duplicate: false,
      document: {
        ...document,
        provider_file_id: indexed.providerFileId,
        provider_vector_store_file_id: indexed.providerVectorStoreFileId,
        status: indexed.status,
        local_retrieval_status: localIndex.status,
        local_chunk_count: localIndex.chunkCount,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Knowledge indexing failed";
    await db.from("knowledge_documents").update({
      status: "failed",
      error: message.slice(0, 1000),
      updated_at: new Date().toISOString(),
    }).eq("id", documentId).eq("organization_id", input.organizationId);
    return {
      duplicate: false,
      document: {
        ...document,
        status: "failed",
        error: message.slice(0, 1000),
        local_retrieval_status: localIndex.status,
        local_chunk_count: localIndex.chunkCount,
      },
    };
  }
}

export async function refreshKnowledgeDocumentStatus(organizationId: string, documentId: string) {
  const db = createAdminClient();
  const { data: doc, error } = await db
    .from("knowledge_documents")
    .select("id,status,provider,provider_vector_store_file_id,local_retrieval_status,local_chunk_count,local_indexed_at,error")
    .eq("organization_id", organizationId)
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!doc?.provider_vector_store_file_id) return doc;

  const { data: kb, error: kbError } = await db
    .from("organization_knowledge_bases")
    .select("external_vector_store_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (kbError) throw new Error(kbError.message);
  if (!kb?.external_vector_store_id) return doc;

  const result = await getVectorStoreFileStatus(kb.external_vector_store_id, doc.provider_vector_store_file_id);
  const status = result.status === "completed" ? "ready" : result.status === "failed" || result.status === "cancelled" ? "failed" : "indexing";
  const errorText = result.last_error ? JSON.stringify(result.last_error).slice(0, 1000) : null;
  await db.from("knowledge_documents").update({
    status,
    error: errorText,
    updated_at: new Date().toISOString(),
  }).eq("id", documentId).eq("organization_id", organizationId);
  return { ...doc, status, error: errorText };
}
