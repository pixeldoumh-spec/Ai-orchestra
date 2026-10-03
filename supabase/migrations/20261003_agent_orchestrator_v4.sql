-- V4: identities, encrypted credentials, scoped connectors, signed request provenance and circuit breaking.
create table if not exists public.connectors(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check(char_length(name) between 2 and 120),kind text not null check(kind in('reserved','http')),base_url text,
 status text not null default 'active' check(status in('active','degraded','disabled')),auth_scheme text not null default 'none' check(auth_scheme in('none','bearer','api_key','hmac')),
 version text not null default '1.0.0',circuit_state text not null default 'closed' check(circuit_state in('closed','open')),consecutive_failures integer not null default 0 check(consecutive_failures>=0),
 failure_threshold integer not null default 3 check(failure_threshold between 1 and 20),cooldown_seconds integer not null default 60 check(cooldown_seconds between 5 and 3600),cooldown_until timestamptz,
 fallback_connector_id uuid references public.connectors(id) on delete set null,last_success_at timestamptz,last_failure_at timestamptz,created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(organization_id,id),check(base_url is null or base_url~'^https://'),check(fallback_connector_id is null or fallback_connector_id<>id),
constraint connectors_fallback_fk foreign key (organization_id, fallback_connector_id)
  references public.connectors(organization_id, id) on delete set null
);
create table if not exists public.agent_identities(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,agent_id text not null,public_key text not null,private_key_ciphertext text not null,private_key_iv text not null,private_key_auth_tag text not null,
 key_version integer not null check(key_version>=1),identity_fingerprint text not null check(char_length(identity_fingerprint)=64),status text not null default 'active' check(status in('active','revoked')),
 last_rotated_at timestamptz not null default now(),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(organization_id,agent_id),
 constraint agent_identities_agent_fk foreign key(organization_id,agent_id) references public.agents(organization_id,id) on delete cascade
);
create table if not exists public.connector_credentials(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,connector_id uuid not null,name text not null check(char_length(name) between 2 and 120),scopes text[] not null default '{}',
 auth_scheme text not null check(auth_scheme in('none','bearer','api_key','hmac')),status text not null default 'active' check(status in('active','revoked','expired')),
 secret_ciphertext text not null,secret_iv text not null,secret_auth_tag text not null,key_version integer not null check(key_version>=1),expires_at timestamptz,rotated_at timestamptz,created_by uuid references auth.users(id) on delete set null,created_at timestamptz not null default now(),
 constraint connector_credentials_connector_fk foreign key(organization_id,connector_id) references public.connectors(organization_id,id) on delete cascade
);
create table if not exists public.agent_connector_bindings(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,agent_id text not null,connector_id uuid not null,credential_id uuid references public.connector_credentials(id) on delete set null,
 allowed_tools text[] not null default '{}',scopes text[] not null default '{}',priority integer not null default 100 check(priority between 0 and 10000),status text not null default 'active' check(status in('active','revoked')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(organization_id,agent_id,connector_id),
 constraint agent_connector_bindings_agent_fk foreign key(organization_id,agent_id) references public.agents(organization_id,id) on delete cascade,
 constraint agent_connector_bindings_connector_fk foreign key(organization_id,connector_id) references public.connectors(organization_id,id) on delete cascade
);
create table if not exists public.connector_requests(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,task_id text not null,step_id text not null references public.task_steps(id) on delete cascade,agent_id text not null,
 connector_id uuid not null references public.connectors(id) on delete restrict,credential_id uuid references public.connector_credentials(id) on delete set null,request_id text not null unique,nonce text not null,payload_hash text not null check(char_length(payload_hash)=64),
 signature text not null,key_version integer not null check(key_version>=1),status text not null default 'prepared' check(status in('prepared','approved','denied','executed','failed','expired')),expires_at timestamptz not null,completed_at timestamptz,created_at timestamptz not null default now(),
 constraint connector_requests_task_org_fk foreign key(task_id,organization_id) references public.tasks(id,organization_id) on delete cascade,unique(connector_id,nonce)
);
create table if not exists public.tool_invocations(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,task_id text not null references public.tasks(id) on delete cascade,step_id text not null references public.task_steps(id) on delete cascade,agent_id text not null,tool_id text not null,
 connector_request_id uuid references public.connector_requests(id) on delete set null,status text not null check(status in('requested','approval_required','approved','denied','executed','failed')),
 input_hash text not null check(char_length(input_hash)=64),output_hash text,policy_decision text not null,completed_at timestamptz,created_at timestamptz not null default now()
);
create table if not exists public.connector_health_events(
 id bigint generated always as identity primary key,organization_id uuid not null references public.organizations(id) on delete cascade,connector_id uuid not null references public.connectors(id) on delete cascade,
 outcome text not null check(outcome in('success','failure')),latency_ms integer not null default 0 check(latency_ms>=0),http_status integer,error_class text,source text not null default 'connector-runtime',created_at timestamptz not null default now()
);
alter table public.approvals add column if not exists connector_request_id uuid references public.connector_requests(id) on delete set null;
create index if not exists connectors_org_status_idx on public.connectors(organization_id,status,circuit_state);
create index if not exists connector_credentials_scope_idx on public.connector_credentials(organization_id,connector_id,status);
create index if not exists agent_connector_bindings_route_idx on public.agent_connector_bindings(organization_id,agent_id,status,priority);
create index if not exists connector_requests_task_idx on public.connector_requests(task_id,created_at desc);
create index if not exists tool_invocations_task_idx on public.tool_invocations(task_id,created_at desc);
create index if not exists connector_health_events_idx on public.connector_health_events(organization_id,connector_id,created_at desc);
alter table public.connectors enable row level security;alter table public.agent_identities enable row level security;alter table public.connector_credentials enable row level security;alter table public.agent_connector_bindings enable row level security;alter table public.connector_requests enable row level security;alter table public.tool_invocations enable row level security;alter table public.connector_health_events enable row level security;
drop policy if exists "org members can read connectors" on public.connectors;
create policy "org members can read connectors" on public.connectors for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=connectors.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "org members can read connector bindings" on public.agent_connector_bindings;
create policy "org members can read connector bindings" on public.agent_connector_bindings for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=agent_connector_bindings.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "org members can read tool invocations" on public.tool_invocations;
create policy "org members can read tool invocations" on public.tool_invocations for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=tool_invocations.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "org members can read connector health" on public.connector_health_events;
create policy "org members can read connector health" on public.connector_health_events for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=connector_health_events.organization_id and m.user_id=(select auth.uid())));
revoke all on table public.connectors,public.agent_identities,public.connector_credentials,public.agent_connector_bindings,public.connector_requests,public.tool_invocations,public.connector_health_events from anon,authenticated;
grant select on table public.connectors,public.agent_connector_bindings,public.tool_invocations,public.connector_health_events to authenticated;
create or replace function public.record_connector_outcome(p_organization_id uuid,p_connector_id uuid,p_success boolean,p_latency_ms integer default 0,p_http_status integer default null,p_error_class text default null,p_source text default 'connector-runtime',p_now timestamptz default now())
returns table(circuit_state text,consecutive_failures integer,cooldown_until timestamptz)
language plpgsql security invoker as $$
declare c public.connectors%rowtype; nf integer; ns text; nc timestamptz;
begin
 select * into c from public.connectors where id=p_connector_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Connector not found'; end if;
 if p_success then nf:=0;ns:='closed';nc:=null; else nf:=c.consecutive_failures+1;if nf>=c.failure_threshold then ns:='open';nc:=p_now+make_interval(secs=>c.cooldown_seconds);else ns:='closed';nc:=null;end if;end if;
 update public.connectors set circuit_state=ns,consecutive_failures=nf,cooldown_until=nc,last_success_at=case when p_success then p_now else last_success_at end,last_failure_at=case when p_success then last_failure_at else p_now end,
 status=case when status='disabled' then 'disabled' when p_success then 'active' else 'degraded' end,updated_at=p_now where id=p_connector_id and organization_id=p_organization_id;
 insert into public.connector_health_events(organization_id,connector_id,outcome,latency_ms,http_status,error_class,source,created_at)
 values(p_organization_id,p_connector_id,case when p_success then 'success' else 'failure' end,greatest(0,p_latency_ms),p_http_status,left(p_error_class,120),left(p_source,120),p_now);
 return query select ns,nf,nc;
end;$$;
revoke execute on function public.record_connector_outcome(uuid,uuid,boolean,integer,integer,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.record_connector_outcome(uuid,uuid,boolean,integer,integer,text,text,timestamptz) to service_role;
comment on table public.connector_credentials is 'Encrypted connector secrets; browser roles have no read access.';
comment on table public.agent_identities is 'Per-agent signing identities; private keys are encrypted at rest.';
comment on table public.connector_requests is 'Signed, expiring connector intents with nonce replay protection and provenance.';
comment on table public.tool_invocations is 'Tool provenance stored as hashes instead of raw potentially sensitive payloads.';
