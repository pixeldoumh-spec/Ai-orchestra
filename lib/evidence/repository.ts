import { createAdminClient } from "@/lib/supabase/admin";
import { hashJson } from "@/lib/vault/crypto";
import type { ModelCitation } from "@/lib/orchestrator/types";

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
  claim?: string | null;
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
      claim: input.claim ? input.claim.slice(0, 4000) : null,
      excerpt: input.excerpt ? input.excerpt.slice(0, 4000) : null,
      content_hash: input.contentHash ?? null,
      confidence: input.confidence ?? null,
      citation_index: input.citationIndex ?? null,
      metadata: input.metadata ?? {},
    })
    .select("id,source_type,source_url,source_title,document_id,connector_id,external_ref,claim,excerpt,confidence,citation_index,metadata,created_at")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listTaskEvidence(organizationId: string, taskId: string) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("evidence_packets")
    .select("id,step_id,agent_id,source_type,source_url,source_title,document_id,connector_id,external_ref,claim,excerpt,confidence,citation_index,metadata,created_at")
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
  citations: ModelCitation[];

}) {
  const db = createAdminClient();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const citation of input.citations.slice(0, 50)) {
    const dedupeKey = [
      citation.kind,
      citation.url ?? "",
      citation.fileId ?? "",
      citation.startIndex ?? "",
      citation.title ?? citation.filename ?? "",
    ].join("|");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
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
      claim: excerptAround(input.outputText, citation.startIndex, 240),
      excerpt: citation.excerpt ?? excerptAround(input.outputText, citation.startIndex),
      confidence: typeof citation.score === "number" && Number.isFinite(citation.score)
        ? Math.max(0, Math.min(1, citation.score))
        : null,
      citationIndex: citation.startIndex ?? null,
      metadata: {
        citation_kind: citation.kind,
        end_index: citation.endIndex ?? null,
        retrieval_score: citation.score ?? null,
      },
    });
    ids.push(packet.id);
  }
  return ids;
}
