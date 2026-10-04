-- V6.2: real evidence, document retrieval, citations and connector execution.
create table if not exists public.evidence_collections(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 provider text not null default 'openai' check(provider='openai'),
 external_vector_store_id text not null unique,
 name text not null check(char_length(name) between 2 and 120),
 status text not null default 'active' check(status in('active','disabled')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id)
);

create table if not exists public.evidence_documents(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 collection_id uuid not null references public.evidence_collections(id) on delete cascade,
 external_file_id text not null unique,
 external_vector_store_file_id text,
 filename text not null check(char_length(filename) between 1 and 255),
 mime_type text,
 byte_size bigint not null check(byte_size>0),
 content_sha256 text not null check(char_length(content_sha256)=64),
 status text not null default 'indexing' check(status in('indexing','completed','failed','deleted')),
 last_error text,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,content_sha256)
);

create table if not exists public.task_evidence_documents(
 organization_id uuid not null references public.organizations(id) on delete cascade,
 task_id text not null,
 document_id uuid not null references public.evidence_documents(id) on delete cascade,
 created_at timestamptz not null default now(),
 primary key(task_id,document_id),
 constraint task_evidence_task_org_fk foreign key(task_id,organization_id) references public.tasks(id,organization_id) on delete cascade
);

create table if not exists public.evidence_packets(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 task_id text not null,
 step_id text not null,
 model text,
 source_kind text not null default 'none' check(source_kind in('none','web','document','mixed')),
 answer_sha256 text check(answer_sha256 is null or char_length(answer_sha256)=64),
 citation_count integer not null default 0 check(citation_count>=0),
 search_count integer not null default 0 check(search_count>=0),
 created_at timestamptz not null default now(),
 constraint evidence_packets_task_org_fk foreign key(task_id,organization_id) references public.tasks(id,organization_id) on delete cascade,
 constraint evidence_packets_step_fk foreign key(step_id) references public.task_steps(id) on delete cascade
);

create table if not exists public.evidence_citations(
 id uuid primary key default gen_random_uuid(),
 packet_id uuid not null references public.evidence_packets(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 ordinal integer not null check(ordinal>=0),
 kind text not null check(kind in('url','file')),
 title text,
 url text,
 external_file_id text,
 filename text,
 source_sha256 text not null check(char_length(source_sha256)=64),
 start_index integer,
 end_index integer,
 created_at timestamptz not null default now(),
 unique(packet_id,ordinal),
 check(kind='url' and url is not null or kind='file' and external_file_id is not null)
);

create table if not exists public.evidence_searches(
 id bigint generated always as identity primary key,
 packet_id uuid not null references public.evidence_packets(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 query_sha256 text not null check(char_length(query_sha256)=64),
 source_count integer not null default 0 check(source_count>=0),
 created_at timestamptz not null default now()
);

alter table public.connector_requests add column if not exists action_method text;
alter table public.connector_requests add column if not exists action_path text;
alter table public.connector_requests add column if not exists action_payload_ciphertext text;
alter table public.connector_requests add column if not exists action_payload_iv text;
alter table public.connector_requests add column if not exists action_payload_auth_tag text;
alter table public.connector_requests add column if not exists action_payload_key_version integer;
alter table public.connector_requests add column if not exists http_status integer;
alter table public.connector_requests add column if not exists response_hash text;
alter table public.connector_requests add column if not exists latency_ms integer;

create index if not exists evidence_documents_org_idx on public.evidence_documents(organization_id,created_at desc);
create index if not exists evidence_documents_collection_idx on public.evidence_documents(collection_id,status,created_at desc);
create index if not exists task_evidence_documents_org_task_idx on public.task_evidence_documents(organization_id,task_id);
create index if not exists evidence_packets_task_idx on public.evidence_packets(organization_id,task_id,created_at desc);
create index if not exists evidence_citations_packet_idx on public.evidence_citations(packet_id,ordinal);
create index if not exists evidence_searches_packet_idx on public.evidence_searches(packet_id,created_at);
create index if not exists connector_requests_exec_idx on public.connector_requests(organization_id,status,expires_at);

alter table public.evidence_collections enable row level security;
alter table public.evidence_documents enable row level security;
alter table public.task_evidence_documents enable row level security;
alter table public.evidence_packets enable row level security;
alter table public.evidence_citations enable row level security;
alter table public.evidence_searches enable row level security;

drop policy if exists "org members can read evidence collections" on public.evidence_collections;
create policy "org members can read evidence collections" on public.evidence_collections
 for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=evidence_collections.organization_id and m.user_id=(select auth.uid())));

drop policy if exists "org members can read evidence documents" on public.evidence_documents;
create policy "org members can read evidence documents" on public.evidence_documents
 for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=evidence_documents.organization_id and m.user_id=(select auth.uid())));

drop policy if exists "org members can read task evidence documents" on public.task_evidence_documents;
create policy "org members can read task evidence documents" on public.task_evidence_documents
 for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=task_evidence_documents.organization_id and m.user_id=(select auth.uid())));

drop policy if exists "org members can read evidence packets" on public.evidence_packets;
create policy "org members can read evidence packets" on public.evidence_packets
 for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=evidence_packets.organization_id and m.user_id=(select auth.uid())));

drop policy if exists "org members can read evidence citations" on public.evidence_citations;
create policy "org members can read evidence citations" on public.evidence_citations
 for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=evidence_citations.organization_id and m.user_id=(select auth.uid())));

drop policy if exists "org members can read evidence searches" on public.evidence_searches;
create policy "org members can read evidence searches" on public.evidence_searches
 for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=evidence_searches.organization_id and m.user_id=(select auth.uid())));

revoke all on table public.evidence_collections,public.evidence_documents,public.task_evidence_documents,public.evidence_packets,public.evidence_citations,public.evidence_searches from anon,authenticated;
grant select on table public.evidence_collections,public.evidence_documents,public.task_evidence_documents,public.evidence_packets,public.evidence_citations,public.evidence_searches to authenticated;

comment on table public.evidence_documents is 'Document metadata only; raw document bytes remain in the provider vector store.';
comment on table public.evidence_packets is 'Evidence provenance for a model step; content is represented by hashes and citations, not raw prompts.';
comment on table public.evidence_citations is 'Citations extracted from provider response annotations.';
comment on table public.evidence_searches is 'Hashed web-search queries for provenance without retaining raw task prompts.';
comment on table public.connector_requests is 'Signed connector intents; V6.2 action fields are encrypted and execution outcome is recorded without raw response bodies.';
