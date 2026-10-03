-- V5: agent network discovery, explicit cross-organization sharing,
-- capability negotiation, durable agent-to-agent delegations, and reputation.

create table if not exists public.agent_listings(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id text not null,
  slug text not null check(slug ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$'),
  title text not null check(char_length(title) between 2 and 120),
  description text not null check(char_length(description) between 10 and 2000),
  capabilities_snapshot text[] not null default '{}',
  tags text[] not null default '{}',
  visibility text not null default 'unlisted' check(visibility in('public','unlisted')),
  status text not null default 'draft' check(status in('draft','published','suspended')),
  delegation_mode text not null default 'manual' check(delegation_mode in('manual','auto')),
  agent_version text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,slug),
  unique(organization_id,agent_id),
  constraint agent_listings_agent_fk foreign key(organization_id,agent_id)
    references public.agents(organization_id,id) on delete cascade
);

create table if not exists public.agent_shares(
  id uuid primary key default gen_random_uuid(),
  provider_organization_id uuid not null references public.organizations(id) on delete cascade,
  consumer_organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id text not null,
  allowed_capabilities text[] not null default '{}',
  max_cost_cents integer not null check(max_cost_cents > 0),
  auto_accept boolean not null default false,
  status text not null default 'active' check(status in('active','revoked')),
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider_organization_id,consumer_organization_id,agent_id),
  check(provider_organization_id <> consumer_organization_id),
  constraint agent_shares_agent_fk foreign key(provider_organization_id,agent_id)
    references public.agents(organization_id,id) on delete cascade
);

create table if not exists public.agent_reputation(
  organization_id uuid not null,
  agent_id text not null,
  total_delegations integer not null default 0 check(total_delegations >= 0),
  completed_count integer not null default 0 check(completed_count >= 0),
  failed_count integer not null default 0 check(failed_count >= 0),
  trust_score numeric(5,2) not null default 50.00 check(trust_score between 0 and 100),
  avg_latency_ms numeric(12,2) not null default 0 check(avg_latency_ms >= 0),
  updated_at timestamptz not null default now(),
  primary key(organization_id,agent_id),
  constraint agent_reputation_agent_fk foreign key(organization_id,agent_id)
    references public.agents(organization_id,id) on delete cascade
);

create table if not exists public.network_delegations(
  id uuid primary key default gen_random_uuid(),
  source_organization_id uuid not null references public.organizations(id) on delete cascade,
  source_user_id uuid not null references auth.users(id) on delete restrict,
  source_task_id text,
  source_step_id text,
  source_agent_id text not null,
  provider_organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_agent_id text not null,
  listing_id uuid references public.agent_listings(id) on delete set null,
  share_id uuid references public.agent_shares(id) on delete set null,
  request_id text not null unique check(char_length(request_id) between 16 and 160),
  idempotency_key text not null check(char_length(idempotency_key) between 8 and 128),
  requested_capabilities text[] not null default '{}',
  negotiated_capabilities text[] not null default '{}',
  objective text not null check(char_length(objective) between 5 and 4000),
  contract jsonb not null default '{}'::jsonb,
  contract_hash text not null check(char_length(contract_hash)=64),
  min_trust_score numeric(5,2) not null default 0 check(min_trust_score between 0 and 100),
  trust_score_snapshot numeric(5,2) not null default 50 check(trust_score_snapshot between 0 and 100),
  max_cost_cents integer not null check(max_cost_cents > 0),
  spent_cost_cents integer not null default 0 check(spent_cost_cents >= 0),
  status text not null default 'requested' check(status in('requested','accepted','running','completed','rejected','failed','expired','cancelled')),
  result jsonb,
  result_hash text check(result_hash is null or char_length(result_hash)=64),
  error text,
  attempt_count integer not null default 0 check(attempt_count >= 0),
  max_attempts integer not null default 2 check(max_attempts between 1 and 3),
  provider_resolved_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  latency_ms integer check(latency_ms is null or latency_ms >= 0),
  lease_owner text,
  lease_until timestamptz,
  constraint network_delegations_provider_agent_fk foreign key(provider_organization_id,provider_agent_id)
    references public.agents(organization_id,id) on delete restrict,
  constraint network_delegations_source_task_fk foreign key(source_task_id,source_organization_id)
    references public.tasks(id,organization_id) on delete set null,
  unique(source_organization_id,idempotency_key),
  check(source_organization_id <> provider_organization_id)
);

create table if not exists public.network_reputation_events(
  id bigint generated always as identity primary key,
  provider_organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_agent_id text not null,
  source_organization_id uuid not null references public.organizations(id) on delete cascade,
  delegation_id uuid not null references public.network_delegations(id) on delete cascade,
  outcome text not null check(outcome in('success','failure')),
  latency_ms integer not null default 0 check(latency_ms >= 0),
  created_at timestamptz not null default now(),
  constraint network_reputation_provider_agent_fk foreign key(provider_organization_id,provider_agent_id)
    references public.agents(organization_id,id) on delete cascade
);

alter table public.agent_listings enable row level security;
alter table public.agent_shares enable row level security;
alter table public.agent_reputation enable row level security;
alter table public.network_delegations enable row level security;
alter table public.network_reputation_events enable row level security;

revoke all on table public.agent_listings,public.agent_shares,public.agent_reputation,public.network_delegations,public.network_reputation_events from anon,authenticated;

create index if not exists agent_listings_discovery_idx on public.agent_listings(status,visibility,created_at desc);
create index if not exists agent_shares_consumer_idx on public.agent_shares(consumer_organization_id,status,expires_at);
create index if not exists agent_shares_provider_idx on public.agent_shares(provider_organization_id,status,expires_at);
create index if not exists network_delegations_source_idx on public.network_delegations(source_organization_id,status,created_at desc);
create index if not exists network_delegations_provider_idx on public.network_delegations(provider_organization_id,status,created_at desc);
create index if not exists network_delegations_queue_idx on public.network_delegations(status,expires_at,lease_until,created_at);
create index if not exists network_reputation_events_agent_idx on public.network_reputation_events(provider_organization_id,provider_agent_id,created_at desc);

create or replace function public.record_agent_reputation(
  p_organization_id uuid,
  p_agent_id text,
  p_success boolean,
  p_latency_ms integer default 0,
  p_delegation_id uuid default null,
  p_source_organization_id uuid default null,
  p_now timestamptz default now()
) returns table(trust_score numeric,total_delegations integer,completed_count integer,failed_count integer,avg_latency_ms numeric)
language plpgsql security invoker
as $$
declare r public.agent_reputation%rowtype; new_total integer; new_completed integer; new_failed integer; new_avg numeric;
begin
  select * into r from public.agent_reputation where organization_id=p_organization_id and agent_id=p_agent_id for update;
  if not found then
    insert into public.agent_reputation(organization_id,agent_id,total_delegations,completed_count,failed_count,trust_score,avg_latency_ms,updated_at)
    values(p_organization_id,p_agent_id,1,case when p_success then 1 else 0 end,case when p_success then 0 else 1 end,
      case when p_success then 55.00 else 45.00 end,greatest(0,p_latency_ms),p_now)
    returning * into r;
  else
    new_total:=r.total_delegations+1;
    new_completed:=r.completed_count+case when p_success then 1 else 0 end;
    new_failed:=r.failed_count+case when p_success then 0 else 1 end;
    new_avg:=((r.avg_latency_ms*r.total_delegations)+greatest(0,p_latency_ms))/new_total;
    update public.agent_reputation
      set total_delegations=new_total,completed_count=new_completed,failed_count=new_failed,
          trust_score=round((100.0*(new_completed+8.0)/(new_total+16.0))::numeric,2),
          avg_latency_ms=round(new_avg,2),updated_at=p_now
      where organization_id=p_organization_id and agent_id=p_agent_id
      returning * into r;
  end if;
  if p_delegation_id is not null and p_source_organization_id is not null then
    insert into public.network_reputation_events(provider_organization_id,provider_agent_id,source_organization_id,delegation_id,outcome,latency_ms)
    values(p_organization_id,p_agent_id,p_source_organization_id,p_delegation_id,case when p_success then 'success' else 'failure' end,greatest(0,p_latency_ms));
  end if;
  return query select r.trust_score,r.total_delegations,r.completed_count,r.failed_count,r.avg_latency_ms;
end;
$$;

revoke execute on function public.record_agent_reputation(uuid,text,boolean,integer,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.record_agent_reputation(uuid,text,boolean,integer,uuid,uuid,timestamptz) to service_role;

comment on table public.agent_listings is 'Discoverable agent marketplace metadata; never contains credentials.';
comment on table public.agent_shares is 'Provider-controlled cross-organization access grants for one agent.';
comment on table public.network_delegations is 'Durable agent-to-agent work contracts; remote execution is model-only and tool-isolated.';
comment on table public.agent_reputation is 'Aggregated reliability signals for network agent discovery.';
