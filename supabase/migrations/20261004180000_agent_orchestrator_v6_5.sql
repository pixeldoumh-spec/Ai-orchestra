-- V6.5: workspace knowledge plane.
-- Durable memory + semantic retrieval + document chunks + strict tenant boundaries.

create extension if not exists vector;

create table if not exists public.knowledge_memories(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  kind text not null default 'fact' check(kind in('fact','preference','decision','procedure','context')),
  visibility text not null default 'workspace' check(visibility in('workspace','private')),
  content text not null check(char_length(trim(content)) between 1 and 12000),
  content_sha256 text not null check(char_length(content_sha256)=64),
  source_type text not null default 'user' check(source_type in('user','task','document','agent')),
  source_ref text,
  confidence numeric(5,4) not null default 1 check(confidence between 0 and 1),
  importance smallint not null default 50 check(importance between 0 and 100),
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active' check(status in('active','superseded','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists knowledge_memories_dedupe_idx
  on public.knowledge_memories(organization_id,coalesce(user_id,'00000000-0000-0000-0000-000000000000'::uuid),content_sha256)
  where status <> 'deleted';
create index if not exists knowledge_memories_org_idx on public.knowledge_memories(organization_id,status,created_at desc);
create index if not exists knowledge_memories_private_idx on public.knowledge_memories(organization_id,user_id,status,created_at desc);
create index if not exists knowledge_memories_expiry_idx on public.knowledge_memories(organization_id,expires_at)
  where expires_at is not null and status='active';
create index if not exists knowledge_memories_fts_idx
  on public.knowledge_memories using gin(to_tsvector('simple',content));

alter table public.knowledge_memories enable row level security;
drop policy if exists "members can read workspace memories" on public.knowledge_memories;
create policy "members can read workspace memories" on public.knowledge_memories
for select to authenticated using(
  exists(select 1 from public.organization_members m
    where m.organization_id=knowledge_memories.organization_id
      and m.user_id=(select auth.uid())
      and knowledge_memories.status <> 'deleted'
      and (knowledge_memories.visibility='workspace' or knowledge_memories.user_id=(select auth.uid())))
);

revoke all on table public.knowledge_memories from anon,authenticated;
grant select on table public.knowledge_memories to authenticated;

drop trigger if exists knowledge_memory_immutable_trigger on public.knowledge_memories;
create or replace function public.v65_memory_immutable() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,auth,extensions as $$
begin
  if TG_OP='DELETE' then raise exception 'V6.5 memory records are soft-delete only'; end if;
  if NEW.organization_id is distinct from OLD.organization_id
     or NEW.user_id is distinct from OLD.user_id
     or NEW.kind is distinct from OLD.kind
     or NEW.visibility is distinct from OLD.visibility
     or NEW.content is distinct from OLD.content
     or NEW.content_sha256 is distinct from OLD.content_sha256
     or NEW.source_type is distinct from OLD.source_type
     or NEW.source_ref is distinct from OLD.source_ref
     or NEW.confidence is distinct from OLD.confidence
     or NEW.importance is distinct from OLD.importance
     or NEW.created_at is distinct from OLD.created_at then
    raise exception 'V6.5 memory identity/content is immutable';
  end if;
  return NEW;
end;
$$;
create trigger knowledge_memory_immutable_trigger before update or delete on public.knowledge_memories
for each row execute function public.v65_memory_immutable();
revoke execute on function public.v65_memory_immutable() from public,anon,authenticated;

create table if not exists public.knowledge_chunks(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_id uuid references public.knowledge_documents(id) on delete cascade,
  memory_id uuid references public.knowledge_memories(id) on delete cascade,
  chunk_index integer not null default 0 check(chunk_index>=0),
  content text not null check(char_length(trim(content)) between 1 and 10000),
  content_sha256 text not null check(char_length(content_sha256)=64),
  embedding vector(768) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint knowledge_chunks_one_source check(
    (document_id is not null and memory_id is null) or (document_id is null and memory_id is not null)
  ),
  unique(organization_id,content_sha256)
);

create index if not exists knowledge_chunks_org_idx on public.knowledge_chunks(organization_id,created_at desc);
create index if not exists knowledge_chunks_document_idx on public.knowledge_chunks(organization_id,document_id,chunk_index);
create index if not exists knowledge_chunks_memory_idx on public.knowledge_chunks(organization_id,memory_id);
create index if not exists knowledge_chunks_embedding_idx on public.knowledge_chunks using ivfflat(embedding vector_cosine_ops) with(lists=100);

alter table public.knowledge_chunks enable row level security;
drop policy if exists "knowledge chunks deny browser access" on public.knowledge_chunks;
create policy "knowledge chunks deny browser access" on public.knowledge_chunks
for all to authenticated using(false) with check(false);
revoke all on table public.knowledge_chunks from anon,authenticated;

alter table public.knowledge_documents
  add column if not exists local_retrieval_status text not null default 'not_indexed'
    check(local_retrieval_status in('not_indexed','indexing','indexed','unsupported','failed')),
  add column if not exists local_chunk_count integer not null default 0 check(local_chunk_count>=0),
  add column if not exists local_indexed_at timestamptz;

create index if not exists knowledge_documents_local_idx
  on public.knowledge_documents(organization_id,local_retrieval_status,created_at desc);

create table if not exists public.knowledge_retrieval_events(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  task_id text references public.tasks(id) on delete set null,
  query_hash text not null check(char_length(query_hash)=64),
  result_count integer not null default 0 check(result_count between 0 and 100),
  memory_count integer not null default 0 check(memory_count between 0 and 100),
  document_count integer not null default 0 check(document_count between 0 and 100),
  created_at timestamptz not null default now()
);
create index if not exists knowledge_retrieval_events_org_idx on public.knowledge_retrieval_events(organization_id,created_at desc);
alter table public.knowledge_retrieval_events enable row level security;
drop policy if exists "members can read retrieval events" on public.knowledge_retrieval_events;
create policy "members can read retrieval events" on public.knowledge_retrieval_events for select to authenticated
using(exists(select 1 from public.organization_members m where m.organization_id=knowledge_retrieval_events.organization_id and m.user_id=(select auth.uid())));
revoke all on table public.knowledge_retrieval_events from anon,authenticated;
grant select on public.knowledge_retrieval_events to authenticated;

create or replace function public.search_workspace_knowledge(
  p_organization_id uuid,
  p_user_id uuid,
  p_query_embedding vector(768),
  p_limit integer default 8,
  p_include_private boolean default false
)
returns table(
  id uuid,
  source_type text,
  memory_id uuid,
  document_id uuid,
  filename text,
  kind text,
  visibility text,
  content text,
  source_ref text,
  confidence numeric,
  importance integer,
  chunk_index integer,
  score real
)
language sql
security definer
set search_path=pg_catalog,public,auth,extensions as $$
  with ranked as(
    select c.id,
      case when c.memory_id is not null then 'memory' else 'document' end as source_type,
      c.memory_id,c.document_id,d.filename,m.kind,m.visibility,c.content,
      m.source_ref,m.confidence,m.importance,c.chunk_index,
      (1-(c.embedding <=> p_query_embedding))::real as score
    from public.knowledge_chunks c
    left join public.knowledge_memories m
      on m.id=c.memory_id and m.organization_id=c.organization_id
    left join public.knowledge_documents d
      on d.id=c.document_id and d.organization_id=c.organization_id
    where c.organization_id=p_organization_id
      and(
        (c.memory_id is not null and m.status='active'
          and (m.expires_at is null or m.expires_at>now())
          and (m.visibility='workspace' or (p_include_private and m.user_id=p_user_id)))
        or
        (c.document_id is not null and d.status not in('deleted','failed'))
      )
  )
  select * from ranked
  where score > -1
  order by score desc,importance desc,chunk_index asc
  limit greatest(1,least(coalesce(p_limit,8),50));
$$;
revoke all on function public.search_workspace_knowledge(uuid,uuid,vector,integer,boolean) from public,anon,authenticated;
grant execute on function public.search_workspace_knowledge(uuid,uuid,vector,integer,boolean) to service_role;

create or replace function public.search_workspace_memory(
  p_organization_id uuid,
  p_user_id uuid,
  p_query text,
  p_limit integer default 8
)
returns table(
  id uuid, kind text, visibility text, content text, source_type text, source_ref text,
  confidence numeric, importance smallint, created_at timestamptz, score real
)
language sql security definer set search_path=pg_catalog,public,auth,extensions as $$
  with q as(select plainto_tsquery('simple',trim(p_query)) as tsq)
  select m.id,m.kind,m.visibility,m.content,m.source_type,m.source_ref,m.confidence,m.importance,m.created_at,
    ts_rank_cd(to_tsvector('simple',m.content),q.tsq) as score
  from public.knowledge_memories m,q
  where m.organization_id=p_organization_id and m.status='active'
    and (m.expires_at is null or m.expires_at>now())
    and (m.visibility='workspace' or m.user_id=p_user_id)
    and (q.tsq = to_tsquery('simple','') or to_tsvector('simple',m.content) @@ q.tsq)
  order by score desc,m.importance desc,m.created_at desc
  limit greatest(1,least(coalesce(p_limit,8),50));
$$;
revoke all on function public.search_workspace_memory(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.search_workspace_memory(uuid,uuid,text,integer) to service_role;

comment on table public.knowledge_chunks is 'V6.5 tenant-bound semantic chunks. Payload belongs to exactly one workspace document or memory.';
comment on function public.search_workspace_knowledge(uuid,uuid,vector,integer,boolean) is 'Server-only semantic workspace retrieval with explicit organization and private-memory owner boundaries.';
comment on function public.search_workspace_memory(uuid,uuid,text,integer) is 'Server-only lexical fallback memory retrieval with explicit organization and private-memory owner boundaries.';
