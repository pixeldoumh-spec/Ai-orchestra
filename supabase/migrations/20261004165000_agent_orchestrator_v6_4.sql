-- V6.4 agent network policies, delegation metadata and durable autonomous delegation.

create table if not exists public.agent_network_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default true,
  allow_delegation boolean not null default true,
  allowed_message_types text[] not null default array['request','response','event','delegation']::text[],
  allowed_scopes text[] not null default array['task.coordination','agent.delegation.execute','agent.delegation.response']::text[],
  max_delegation_depth integer not null default 2,
  max_payload_bytes integer not null default 65536,
  default_ttl_seconds integer not null default 300,
  max_ttl_seconds integer not null default 3600,
  max_hops integer not null default 4,
  rate_limit_per_minute integer not null default 120,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_network_policies_depth_check check (max_delegation_depth between 0 and 6),
  constraint agent_network_policies_payload_check check (max_payload_bytes between 1024 and 65536),
  constraint agent_network_policies_default_ttl_check check (default_ttl_seconds between 10 and 3600),
  constraint agent_network_policies_max_ttl_check check (max_ttl_seconds between 10 and 3600),
  constraint agent_network_policies_hops_check check (max_hops between 1 and 12),
  constraint agent_network_policies_rate_check check (rate_limit_per_minute between 1 and 600),
  constraint agent_network_policies_types_check check (array_length(allowed_message_types,1) > 0),
  constraint agent_network_policies_scopes_check check (array_length(allowed_scopes,1) > 0)
);

insert into public.agent_network_policies(organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

create or replace function public.touch_agent_network_policy()
returns trigger language plpgsql set search_path to 'pg_catalog','public','auth','extensions'
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists agent_network_policy_touch on public.agent_network_policies;
create trigger agent_network_policy_touch before update on public.agent_network_policies
for each row execute function public.touch_agent_network_policy();

alter table public.agent_network_messages
  add column if not exists task_id text null references public.tasks(id) on delete cascade,
  add column if not exists step_id text null,
  add column if not exists root_message_id text null,
  add column if not exists delegation_depth integer not null default 0,
  add column if not exists hop_count integer not null default 0;

alter table public.agent_network_messages
  drop constraint if exists agent_network_messages_delegation_depth_check,
  drop constraint if exists agent_network_messages_hop_count_check;

alter table public.agent_network_messages
  add constraint agent_network_messages_delegation_depth_check check (delegation_depth between 0 and 6),
  add constraint agent_network_messages_hop_count_check check (hop_count between 0 and 12);

create index if not exists agent_network_messages_task_idx
  on public.agent_network_messages(organization_id, task_id, created_at desc);

create index if not exists agent_network_messages_delivery_idx
  on public.agent_network_messages(organization_id, target_agent_id, status, priority desc, available_at);

alter table public.agent_network_events
  add column if not exists task_id text null references public.tasks(id) on delete cascade;

drop trigger if exists agent_network_message_admission on public.agent_network_messages;
drop trigger if exists agent_network_message_admission_v64 on public.agent_network_messages;
create or replace function public.agent_network_message_admission_v64()
returns trigger language plpgsql
set search_path to 'pg_catalog','public','auth','extensions'
as $$
declare
  p public.agent_network_peers%rowtype;
  pol public.agent_network_policies%rowtype;
  sent_count integer;
begin
  if NEW.status <> 'queued' then raise exception 'Network messages must enter through queued state'; end if;

  select * into pol from public.agent_network_policies where organization_id=NEW.organization_id;
  if not found then
    insert into public.agent_network_policies(organization_id) values(NEW.organization_id)
    on conflict (organization_id) do nothing;
    select * into pol from public.agent_network_policies where organization_id=NEW.organization_id;
  end if;

  if not pol.enabled then raise exception 'Agent network is disabled by organization policy'; end if;
  if not (NEW.kind = any(pol.allowed_message_types)) then raise exception 'Message kind is blocked by organization policy'; end if;
  if not (NEW.scope = any(pol.allowed_scopes) or '*' = any(pol.allowed_scopes) or exists(
    select 1 from unnest(pol.allowed_scopes) s where right(s,2)='.*' and NEW.scope like left(s,length(s)-1)||'%'
  )) then raise exception 'Message scope is blocked by organization policy'; end if;
  if NEW.payload_size_bytes > pol.max_payload_bytes then raise exception 'Message exceeds organization payload policy'; end if;
  if extract(epoch from (NEW.expires_at-NEW.created_at)) > pol.max_ttl_seconds then raise exception 'Message TTL exceeds organization policy'; end if;
  if NEW.delegation_depth > pol.max_delegation_depth then raise exception 'Delegation depth exceeds organization policy'; end if;
  if NEW.hop_count > pol.max_hops then raise exception 'Network hop limit exceeded'; end if;

  if NEW.kind='delegation' and (not pol.allow_delegation or NEW.scope !~ '^agent\.delegation(\.|$)') then
    raise exception 'Autonomous delegation is blocked by organization policy';
  end if;

  select * into p from public.agent_network_peers
  where organization_id=NEW.organization_id and source_agent_id=NEW.sender_agent_id
    and target_agent_id=NEW.target_agent_id and status='active'
  for update;
  if not found then raise exception 'No active network trust edge exists'; end if;
  if not(NEW.kind=any(p.allowed_message_types) or '*'=any(p.allowed_message_types)) then raise exception 'Message kind is outside trust edge'; end if;
  if not(NEW.scope=any(p.allowed_scopes) or '*'=any(p.allowed_scopes) or exists(
    select 1 from unnest(p.allowed_scopes) s where right(s,2)='.*' and NEW.scope like left(s,length(s)-1)||'%'
  )) then raise exception 'Message scope is outside trust edge'; end if;
  if NEW.payload_size_bytes > p.max_payload_bytes then raise exception 'Message exceeds peer payload limit'; end if;

  perform pg_advisory_xact_lock(hashtext(NEW.organization_id::text||':'||NEW.sender_agent_id||':'||NEW.target_agent_id));
  select count(*) into sent_count from public.agent_network_messages
  where organization_id=NEW.organization_id and sender_agent_id=NEW.sender_agent_id
    and target_agent_id=NEW.target_agent_id and created_at >= NEW.created_at-interval '1 minute';
  if sent_count >= least(p.rate_limit_per_minute,pol.rate_limit_per_minute) then raise exception 'Agent network rate limit reached'; end if;

  if NEW.kind='response' then
    if NEW.reply_to_message_id is null then raise exception 'Response must reference a prior message'; end if;
    if not exists(
      select 1 from public.agent_network_messages prior
      where prior.organization_id=NEW.organization_id
        and prior.message_id=NEW.reply_to_message_id
        and prior.sender_agent_id=NEW.target_agent_id
        and prior.target_agent_id=NEW.sender_agent_id
        and prior.kind in('request','delegation')
        and (NEW.correlation_id is null or prior.correlation_id=NEW.correlation_id)
    ) then raise exception 'Response does not reference a matching request'; end if;
  elsif NEW.reply_to_message_id is not null and not exists(
    select 1 from public.agent_network_messages prior where prior.organization_id=NEW.organization_id and prior.message_id=NEW.reply_to_message_id
  ) then
    raise exception 'Reply target not found';
  end if;

  if NEW.task_id is not null and not exists(
    select 1 from public.tasks t where t.id=NEW.task_id and t.organization_id=NEW.organization_id
  ) then raise exception 'Task does not belong to network organization'; end if;

  if NEW.kind='response' and NEW.task_id is distinct from (
    select task_id from public.agent_network_messages prior where prior.message_id=NEW.reply_to_message_id
  ) then raise exception 'Response task lineage mismatch'; end if;

  if NEW.kind='delegation' and NEW.correlation_id is null then raise exception 'Delegation correlation id is required'; end if;
  if NEW.root_message_id is null then NEW.root_message_id := coalesce(
    (select root_message_id from public.agent_network_messages prior where prior.message_id=NEW.reply_to_message_id),
    NEW.message_id
  ); end if;

  return NEW;
end;
$$;

create trigger agent_network_message_admission_v64
before insert on public.agent_network_messages
for each row execute function public.agent_network_message_admission_v64();

drop trigger if exists agent_network_message_immutable on public.agent_network_messages;
drop trigger if exists agent_network_message_immutable_v64 on public.agent_network_messages;
create or replace function public.agent_network_message_immutable_v64()
returns trigger language plpgsql
set search_path to 'pg_catalog','public','auth','extensions'
as $$
begin
  if NEW.organization_id is distinct from OLD.organization_id
     or NEW.message_id is distinct from OLD.message_id
     or NEW.nonce is distinct from OLD.nonce
     or NEW.sender_agent_id is distinct from OLD.sender_agent_id
     or NEW.target_agent_id is distinct from OLD.target_agent_id
     or NEW.conversation_id is distinct from OLD.conversation_id
     or NEW.correlation_id is distinct from OLD.correlation_id
     or NEW.reply_to_message_id is distinct from OLD.reply_to_message_id
     or NEW.kind is distinct from OLD.kind
     or NEW.scope is distinct from OLD.scope
     or NEW.subject is distinct from OLD.subject
     or NEW.task_id is distinct from OLD.task_id
     or NEW.step_id is distinct from OLD.step_id
     or NEW.root_message_id is distinct from OLD.root_message_id
     or NEW.delegation_depth is distinct from OLD.delegation_depth
     or NEW.hop_count is distinct from OLD.hop_count
     or NEW.payload_ciphertext is distinct from OLD.payload_ciphertext
     or NEW.payload_iv is distinct from OLD.payload_iv
     or NEW.payload_auth_tag is distinct from OLD.payload_auth_tag
     or NEW.payload_key_version is distinct from OLD.payload_key_version
     or NEW.payload_hash is distinct from OLD.payload_hash
     or NEW.payload_size_bytes is distinct from OLD.payload_size_bytes
     or NEW.signature is distinct from OLD.signature
     or NEW.signer_key_version is distinct from OLD.signer_key_version
     or NEW.signer_fingerprint is distinct from OLD.signer_fingerprint
     or NEW.created_at is distinct from OLD.created_at then
    raise exception 'Signed network message is immutable';
  end if;
  if OLD.status='queued' and NEW.status not in('delivered','expired','rejected') then raise exception 'Invalid network status transition'; end if;
  if OLD.status='delivered' and NEW.status not in('acknowledged','failed','expired') then raise exception 'Invalid network status transition'; end if;
  if OLD.status in('acknowledged','failed','expired','rejected') and NEW.status is distinct from OLD.status then raise exception 'Terminal network message is immutable'; end if;
  return NEW;
end;
$$;

create trigger agent_network_message_immutable_v64
before update on public.agent_network_messages
for each row execute function public.agent_network_message_immutable_v64();

create or replace function public.claim_agent_network_delegations(
  p_organization_id uuid,
  p_agent_id text,
  p_message_id text default null,
  p_now timestamptz default now()
)
returns setof public.agent_network_messages
language plpgsql
set search_path to 'pg_catalog','public','auth','extensions'
as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text||':delegation:'||p_agent_id));
  update public.agent_network_messages
     set status='expired',last_error='Message TTL expired',last_actor_agent_id=null
   where organization_id=p_organization_id and target_agent_id=p_agent_id
     and status in('queued','delivered') and expires_at<=p_now and kind='delegation';

  return query with picked as (
    select id from public.agent_network_messages
     where organization_id=p_organization_id and target_agent_id=p_agent_id
       and status='queued' and kind='delegation' and available_at<=p_now and expires_at>p_now
       and (p_message_id is null or message_id=p_message_id)
     order by priority desc,created_at asc for update skip locked limit 1
  )
  update public.agent_network_messages m
     set status='delivered',attempt_count=m.attempt_count+1,delivered_at=coalesce(m.delivered_at,p_now),last_actor_agent_id=p_agent_id
   where m.id in(select id from picked)
   returning m.*;
end;
$$;

create or replace function public.record_agent_network_event_v64()
returns trigger language plpgsql
set search_path to 'pg_catalog','public','auth','extensions'
as $$
begin
  if TG_OP='INSERT' then
    insert into public.agent_network_events(organization_id,message_id,task_id,event_type,actor_agent_id,status,metadata)
    values(NEW.organization_id,NEW.id,NEW.task_id,'message.queued',NEW.sender_agent_id,NEW.status,
      jsonb_build_object('messageId',NEW.message_id,'scope',NEW.scope,'kind',NEW.kind,'conversationId',NEW.conversation_id,'correlationId',NEW.correlation_id,'depth',NEW.delegation_depth,'hopCount',NEW.hop_count));
  elsif OLD.status is distinct from NEW.status then
    insert into public.agent_network_events(organization_id,message_id,task_id,event_type,actor_agent_id,status,metadata)
    values(NEW.organization_id,NEW.id,NEW.task_id,'status.'||NEW.status,NEW.last_actor_agent_id,NEW.status,
      jsonb_build_object('messageId',NEW.message_id,'attemptCount',NEW.attempt_count,'lastError',NEW.last_error,'correlationId',NEW.correlation_id));
  end if;
  return NEW;
end;
$$;

drop trigger if exists record_agent_network_event on public.agent_network_messages;
drop trigger if exists record_agent_network_event_v64 on public.agent_network_messages;
create trigger record_agent_network_event_v64
after insert or update of status on public.agent_network_messages
for each row execute function public.record_agent_network_event_v64();

alter table public.agent_network_policies enable row level security;
drop policy if exists "network policies deny browser access" on public.agent_network_policies;
create policy "network policies deny browser access" on public.agent_network_policies
for all using (false) with check (false);
