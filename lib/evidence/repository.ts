import { createAdminClient } from "@/lib/supabase/admin";

export type EvidenceSourceType = "web" | "document" | "connector";

export interface EvidencePacketInput {
  organizationId: string;
  taskId: string;
  stepId?: string | null;
  agentId?: string | null;
  sourceType: EvidenceSourceType;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  documentId?: string | null;
  connectorId?: string | null;
  externalRef?: string | null;
  excerpt?: string | null;
  contentHash?: string | null;
  confidence?: number | null;
  citationIndex?: number | null;
  metadata?: Record<string, unknown>;
}

export async function createEvidencePacket(input: EvidencePacketInput) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("evidence_packets")
    .insert({
      organization_id: input.organizationId,
      task_id: input.taskId,
      step_id: input.stepId ?? null,
      agent_id: input.agentId ?? null,
      source_type: input.sourceType,
      source_url: input.sourceUrl ?? null,
      source_title: input.sourceTitle ?? null,
      document_id: input.documentId ?? null,
      connector_id: input.connectorId ?? null,
      external_ref: input.externalRef ?? null,
      excerpt: input.excerpt ? input.excerpt.slice(0, 4000) : null,
      content_hash: input.contentHash ?? null,
      confidence: input.confidence ?? null,
      citation_index: input.citationIndex ?? null,
      metadata: input.metadata ?? {},
    })
    .select("id,source_type,source_url,source_title,document_id,connector_id,external_ref,excerpt,confidence,citation_index,metadata,created_at")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listTaskEvidence(organizationId: string, taskId: string) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("evidence_packets")
    .select("id,step_id,agent_id,source_type,source_url,source_title,document_id,connector_id,external_ref,excerpt,confidence,citation_index,metadata,created_at")
    .eq("organization_id", organizationId)
    .eq("task_id", taskId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

function excerptAround(text: string, index: number | null | undefined, span = 480) {
  if (!text) return null;
  if (!Number.isFinite(index)) return text.slice(0, 1000);
  const start = Math.max(0, Number(index) - span);
  const end = Math.min(text.length, Number(index) + span);
  return text.slice(start, end).trim();
}

export async function persistModelCitations(input: {
  organizationId: string;
  taskId: string;
  stepId: string;
  agentId: string;
  outputText: string;
  citations: Array<{
    kind: "url" | "file";
    url?: string;
    title?: string;
    fileId?: string;
    filename?: string;
    startIndex?: number;
    endIndex?: number;
  }>;
}) {
  const db = createAdminClient();
  const ids: string[] = [];
  for (const citation of input.citations.slice(0, 50)) {
    let documentId: string | null = null;
    if (citation.kind === "file" && citation.fileId) {
      const { data } = await db
        .from("knowledge_documents")
        .select("id")
        .eq("organization_id", input.organizationId)
        .eq("provider_file_id", citation.fileId)
        .maybeSingle();
      documentId = data?.id ?? null;
    }

    const packet = await createEvidencePacket({
      organizationId: input.organizationId,
      taskId: input.taskId,
      stepId: input.stepId,
      agentId: input.agentId,
      sourceType: citation.kind === "url" ? "web" : "document",
      sourceUrl: citation.url ?? null,
      sourceTitle: citation.title ?? citation.filename ?? null,
      documentId,
      externalRef: citation.fileId ?? null,
      excerpt: excerptAround(input.outputText, citation.startIndex),
      citationIndex: citation.startIndex ?? null,
      metadata: {
        citation_kind: citation.kind,
        end_index: citation.endIndex ?? null,
      },
    });
    ids.push(packet.id);
  }
  return ids;
}
