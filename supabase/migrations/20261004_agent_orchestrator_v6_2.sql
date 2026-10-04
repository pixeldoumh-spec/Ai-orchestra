-- V6.2: real tool and evidence layer.
-- Tenant-scoped knowledge documents, hosted retrieval metadata, evidence packets and citations.

create table if not exists public.organization_knowledge_bases(
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null default 'openai' check(provider in('openai')),
  external_vector_store_id text not null unique,
  status text not null default 'active' check(status in('active','disabled','error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_documents(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  filename text not null check(char_length(filename) between 1 and 255),
  mime_type text not null check(char_length(mime_type) between 1 and 160),
  size_bytes bigint not null check(size_bytes between 1 and 52428800),
  content_sha256 text not null check(char_length(content_sha256)=64),
  storage_bucket text not null default 'knowledge-documents',
  storage_path text not null,
  provider text not null default 'openai' check(provider in('openai')),
  provider_file_id text,
  provider_vector_store_file_id text,
  status text not null default 'stored' check(status in('stored','indexing','ready','failed','deleted')),
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,content_sha256)
);

create index if not exists knowledge_documents_org_status_idx
  on public.knowledge_documents(organization_id,status,created_at desc);
create index if not exists knowledge_documents_provider_file_idx
  on public.knowledge_documents(organization_id,provider_file_id);
create index if not exists knowledge_documents_vector_file_idx
  on public.knowledge_documents(organization_id,provider_vector_store_file_id);

create table if not exists public.evidence_packets(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id text not null references public.tasks(id) on delete cascade,
  step_id text references public.task_steps(id) on delete set null,
  agent_id text,
  source_type text not null check(source_type in('web','document','connector')),
  source_url text,
  source_title text,
  document_id uuid references public.knowledge_documents(id) on delete set null,
  connector_id uuid references public.connectors(id) on delete set null,
  external_ref text,
  excerpt text check(excerpt is null or char_length(excerpt)<=4000),
  content_hash text check(content_hash is null or char_length(content_hash)=64),
  confidence numeric(5,4) check(confidence is null or (confidence>=0 and confidence<=1)),
  citation_index integer check(citation_index is null or citation_index>=0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists evidence_packets_task_idx
  on public.evidence_packets(organization_id,task_id,created_at);
create index if not exists evidence_packets_step_idx
  on public.evidence_packets(organization_id,step_id,created_at);
create index if not exists evidence_packets_document_idx
  on public.evidence_packets(organization_id,document_id,created_at);
create index if not exists evidence_packets_source_idx
  on public.evidence_packets(organization_id,source_type,created_at desc);

alter table public.connector_requests
  add column if not exists input_ciphertext text,
  add column if not exists input_iv text,
  add column if not exists input_auth_tag text,
  add column if not exists input_key_version integer,
  add column if not exists action_method text,
  add column if not exists action_path text;

alter table public.connector_requests
  add constraint connector_requests_input_key_version_ck
  check(input_key_version is null or input_key_version>=1);

create index if not exists connector_requests_execution_idx
  on public.connector_requests(organization_id,status,expires_at);

alter table public.organization_knowledge_bases enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.evidence_packets enable row level security;

drop policy if exists "org members can read knowledge bases" on public.organization_knowledge_bases;
create policy "org members can read knowledge bases"
  on public.organization_knowledge_bases for select to authenticated
  using(exists(
    select 1 from public.organization_members m
    where m.organization_id=organization_knowledge_bases.organization_id
      and m.user_id=(select auth.uid())
  ));

drop policy if exists "org members can read knowledge documents" on public.knowledge_documents;
create policy "org members can read knowledge documents"
  on public.knowledge_documents for select to authenticated
  using(exists(
    select 1 from public.organization_members m
    where m.organization_id=knowledge_documents.organization_id
      and m.user_id=(select auth.uid())
  ));

drop policy if exists "org members can read evidence packets" on public.evidence_packets;
create policy "org members can read evidence packets"
  on public.evidence_packets for select to authenticated
  using(exists(
    select 1 from public.organization_members m
    where m.organization_id=evidence_packets.organization_id
      and m.user_id=(select auth.uid())
  ));

revoke all on table public.organization_knowledge_bases,public.knowledge_documents,public.evidence_packets from anon,authenticated;
grant select on table public.organization_knowledge_bases,public.knowledge_documents,public.evidence_packets to authenticated;

-- Evidence and knowledge metadata are server-managed.
create or replace function public.v62_immutable_record() returns trigger
language plpgsql security invoker
set search_path=pg_catalog,public,auth,extensions as $$
begin
  raise exception 'V6.2 record is append-only';
end;
$$;

drop trigger if exists knowledge_document_immutable_trigger on public.knowledge_documents;
create trigger knowledge_document_immutable_trigger
  before delete on public.knowledge_documents for each row execute function public.v62_immutable_record();

drop trigger if exists evidence_packet_immutable_trigger on public.evidence_packets;
create trigger evidence_packet_immutable_trigger
  before update or delete on public.evidence_packets for each row execute function public.v62_immutable_record();

revoke execute on function public.v62_immutable_record() from public,anon,authenticated;

-- Private bucket. Server-side routes use service-role access.
insert into storage.buckets(id,name,public)
values('knowledge-documents','knowledge-documents',false)
on conflict(id) do update set public=false;

comment on table public.organization_knowledge_bases is
  'Per-organization hosted retrieval index metadata; external vector store IDs are server-managed.';
comment on table public.knowledge_documents is
  'Tenant-scoped document metadata and derived OpenAI indexing state; raw credentials are never stored here.';
comment on table public.evidence_packets is
  'Structured provenance packets linking task steps to web, document or connector evidence.';
