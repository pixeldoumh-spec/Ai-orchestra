import { createAdminClient } from "@/lib/supabase/admin";

const OPENAI_API = "https://api.openai.com/v1";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
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

function apiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  return key;
}

async function openaiJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`${OPENAI_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const status = response.status;
    if (status === 401) throw new Error("OpenAI authentication failed");
    if (status === 429) throw new Error("OpenAI rate limit reached");
    throw new Error(`OpenAI knowledge request failed (${status})`);
  }
  return json as T;
}

export function isSupportedKnowledgeMimeType(mime: string) {
  return SUPPORTED_MIME_TYPES.has(mime.toLowerCase());
}

export async function createKnowledgeVectorStore(organizationId: string) {
  const result = await openaiJson<{ id: string }>("/vector_stores", {
    name: `AI Orchestra knowledge ${organizationId.slice(0, 12)}`,
    metadata: { organization_id: organizationId, product: "ai-orchestra", version: "6.2" },
  });
  if (!result?.id) throw new Error("OpenAI did not return a vector store id");
  return result.id;
}

export async function ensureKnowledgeVectorStore(organizationId: string) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("organization_knowledge_bases")
    .select("organization_id,external_vector_store_id,status")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.external_vector_store_id && data.status === "active") return data.external_vector_store_id;

  const vectorStoreId = await createKnowledgeVectorStore(organizationId);
  const { error: upsertError } = await db
    .from("organization_knowledge_bases")
    .upsert({
      organization_id: organizationId,
      provider: "openai",
      external_vector_store_id: vectorStoreId,
      status: "active",
      updated_at: new Date().toISOString(),
    }, { onConflict: "organization_id" });
  if (upsertError) throw new Error(upsertError.message);
  return vectorStoreId;
}

export async function uploadKnowledgeFile(input: {
  organizationId: string;
  documentId: string;
  file: File;
  filename: string;
  mimeType: string;
}) {
  if (input.file.size < 1 || input.file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Document must be between 1 byte and 50 MB");
  }
  if (!isSupportedKnowledgeMimeType(input.mimeType)) {
    throw new Error("Unsupported document type for knowledge ingestion");
  }

  const arrayBuffer = await input.file.arrayBuffer();
  const blob = new Blob([arrayBuffer], { type: input.mimeType });
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", blob, input.filename);

  const uploadResponse = await fetch(`${OPENAI_API}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  const uploaded = await uploadResponse.json().catch(() => null);
  if (!uploadResponse.ok || typeof uploaded?.id !== "string") {
    if (uploadResponse.status === 401) throw new Error("OpenAI authentication failed");
    if (uploadResponse.status === 429) throw new Error("OpenAI rate limit reached");
    throw new Error(`OpenAI file upload failed (${uploadResponse.status})`);
  }

  const vectorStoreId = await ensureKnowledgeVectorStore(input.organizationId);
  const attached = await openaiJson<{ id: string; status?: string }>(
    `/vector_stores/${encodeURIComponent(vectorStoreId)}/files`,
    {
      file_id: uploaded.id,
      attributes: {
        organization_id: input.organizationId,
        document_id: input.documentId,
        filename: input.filename,
      },
    },
  );

  if (!attached?.id) throw new Error("OpenAI did not return a vector store file id");
  return {
    providerFileId: uploaded.id,
    vectorStoreId,
    providerVectorStoreFileId: attached.id,
    status: attached.status === "completed" ? "ready" as const : "indexing" as const,
  };
}

export async function getVectorStoreFileStatus(vectorStoreId: string, vectorStoreFileId: string) {
  return openaiJson<{ id: string; status: string; last_error?: unknown }>(
    `/vector_stores/${encodeURIComponent(vectorStoreId)}/files/${encodeURIComponent(vectorStoreFileId)}`,
    undefined,
    "GET",
  );
}
