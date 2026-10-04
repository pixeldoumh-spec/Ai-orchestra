-- V6.2 patch: complete durable evidence schema and indexes after staged production migration.

alter table public.evidence_packets
  add column if not exists claim text,
  add column if not exists captured_at timestamptz not null default now();

create index if not exists evidence_packets_task_fk_idx
  on public.evidence_packets(task_id);
create index if not exists evidence_packets_step_fk_idx
  on public.evidence_packets(step_id);
create index if not exists evidence_packets_document_fk_idx
  on public.evidence_packets(document_id);
create index if not exists evidence_packets_connector_fk_idx
  on public.evidence_packets(connector_id);
create index if not exists knowledge_documents_created_by_fk_idx
  on public.knowledge_documents(created_by);

alter table public.connector_requests
  drop constraint if exists connector_requests_status_check;
alter table public.connector_requests
  add constraint connector_requests_status_check
  check(status in('prepared','approved','executing','denied','executed','failed','expired'));

comment on column public.evidence_packets.claim is
  'Decision-relevant claim or proposition grounded by this evidence packet.';
comment on column public.evidence_packets.captured_at is
  'Time the source evidence was captured into the task provenance ledger.';
