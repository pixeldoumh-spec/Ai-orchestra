-- V5 enterprise control plane.
alter table public.organization_members drop constraint if exists organization_members_role_check;
alter table public.organization_members add constraint organization_members_role_check check(role in('owner','admin','operator','billing','auditor','viewer','member'));
alter table public.tasks add column if not exists execution_region text;
alter table public.tasks add column if not exists reservation_period date;
create table if not exists public.organization_entitlements(
 organization_id uuid primary key references public.organizations(id) on delete cascade,plan text not null default 'starter' check(plan in('starter','team','enterprise')),
 monthly_task_limit integer not null default 1000 check(monthly_task_limit between 1 and 100000000),monthly_spend_limit_cents bigint not null default 50000 check(monthly_spend_limit_cents>=0),
 max_agents integer not null default 20 check(max_agents between 1 and 10000),max_members integer not null default 10 check(max_members between 1 and 100000),max_concurrency integer not null default 5 check(max_concurrency between 1 and 10000),
 max_task_cost_cents integer not null default 5000 check(max_task_cost_cents>=0),primary_region text not null default 'ap-south-1' check(char_length(primary_region) between 2 and 64),
 allowed_regions text[] not null default array['ap-south-1'],data_residency text not null default 'in-region' check(data_residency in('in-region','global','restricted')),
 retention_days integer not null default 30 check(retention_days between 1 and 3650),alert_threshold_percent integer not null default 80 check(alert_threshold_percent between 1 and 100),
 features jsonb not null default '{}'::jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.organization_policies(
 organization_id uuid primary key references public.organizations(id) on delete cascade,require_approval_for_external boolean not null default true,
 min_approval_risk text not null default 'high' check(min_approval_risk in('high','critical')),allow_http_connectors boolean not null default true,
 allow_external_actions boolean not null default false,max_task_cost_cents integer not null default 5000 check(max_task_cost_cents>=0),retention_days integer not null default 30 check(retention_days between 1 and 3650),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.enterprise_teams(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,name text not null check(char_length(name) between 2 and 80),
 description text not null default '' check(char_length(description)<=500),created_by uuid not null references auth.users(id) on delete restrict,created_at timestamptz not null default now(),unique(organization_id,name)
);
create table if not exists public.enterprise_team_members(team_id uuid not null references public.enterprise_teams(id) on delete cascade,user_id uuid not null references auth.users(id) on delete cascade,role text not null default 'member' check(role in('lead','member')),created_at timestamptz not null default now(),primary key(team_id,user_id));
create table if not exists public.enterprise_invitations(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,email text not null check(char_length(email) between 3 and 320),
 role text not null check(role in('admin','operator','billing','auditor','viewer','member')),token_hash text not null unique check(char_length(token_hash)=64),invited_by uuid references auth.users(id) on delete set null,expires_at timestamptz not null,accepted_at timestamptz,created_at timestamptz not null default now()
);
create table if not exists public.enterprise_usage_monthly(
 organization_id uuid not null references public.organizations(id) on delete cascade,period_start date not null,task_count integer not null default 0 check(task_count>=0),
 spend_cents bigint not null default 0 check(spend_cents>=0),reserved_cents bigint not null default 0 check(reserved_cents>=0),updated_at timestamptz not null default now(),primary key(organization_id,period_start)
);
create table if not exists public.enterprise_usage_ledger(
 id bigint generated always as identity primary key,organization_id uuid not null references public.organizations(id) on delete cascade,task_id text references public.tasks(id) on delete set null,
 step_id text references public.task_steps(id) on delete set null,kind text not null check(kind in('model','tool','storage','task','other')),quantity bigint not null default 1 check(quantity>0),
 unit_cost_cents integer not null default 0 check(unit_cost_cents>=0),cost_cents bigint not null default 0 check(cost_cents>=0),region text not null,idempotency_key text not null unique,created_at timestamptz not null default now()
);
create table if not exists public.enterprise_audit_logs(
 id bigint generated always as identity primary key,organization_id uuid not null references public.organizations(id) on delete cascade,actor_type text not null,actor_id text,action text not null,
 resource_type text not null,resource_id text,result text not null default 'success' check(result in('success','denied','failed')),metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now()
);
create table if not exists public.enterprise_sla_policies(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,name text not null check(char_length(name) between 2 and 80),
 availability_bps integer not null default 9950 check(availability_bps between 0 and 10000),task_p95_ms integer not null default 300000 check(task_p95_ms>=0),
 support_response_minutes integer not null default 1440 check(support_response_minutes>=0),active boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index if not exists enterprise_teams_org_idx on public.enterprise_teams(organization_id);
create index if not exists enterprise_team_members_user_idx on public.enterprise_team_members(user_id);
create index if not exists enterprise_invites_org_idx on public.enterprise_invitations(organization_id,expires_at);
create index if not exists enterprise_usage_ledger_org_idx on public.enterprise_usage_ledger(organization_id,created_at desc);
create index if not exists enterprise_audit_org_idx on public.enterprise_audit_logs(organization_id,created_at desc);
create index if not exists enterprise_sla_org_idx on public.enterprise_sla_policies(organization_id,active);
alter table public.organization_entitlements enable row level security;alter table public.organization_policies enable row level security;alter table public.enterprise_teams enable row level security;alter table public.enterprise_team_members enable row level security;alter table public.enterprise_invitations enable row level security;alter table public.enterprise_usage_monthly enable row level security;alter table public.enterprise_usage_ledger enable row level security;alter table public.enterprise_audit_logs enable row level security;alter table public.enterprise_sla_policies enable row level security;
drop policy if exists "members can read enterprise entitlements" on public.organization_entitlements;
create policy "members can read enterprise entitlements" on public.organization_entitlements for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=organization_entitlements.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "members can read enterprise policies" on public.organization_policies;
create policy "members can read enterprise policies" on public.organization_policies for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=organization_policies.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "members can read enterprise teams" on public.enterprise_teams;
create policy "members can read enterprise teams" on public.enterprise_teams for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=enterprise_teams.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "members can read enterprise team members" on public.enterprise_team_members;
create policy "members can read enterprise team members" on public.enterprise_team_members for select to authenticated using(exists(select 1 from public.enterprise_teams t join public.organization_members m on m.organization_id=t.organization_id where t.id=enterprise_team_members.team_id and m.user_id=(select auth.uid())));
drop policy if exists "management can read invitations" on public.enterprise_invitations;
create policy "management can read invitations" on public.enterprise_invitations for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=enterprise_invitations.organization_id and m.user_id=(select auth.uid()) and m.role in('owner','admin')));
drop policy if exists "billing roles can read usage monthly" on public.enterprise_usage_monthly;
create policy "billing roles can read usage monthly" on public.enterprise_usage_monthly for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=enterprise_usage_monthly.organization_id and m.user_id=(select auth.uid()) and m.role in('owner','admin','billing')));
drop policy if exists "billing roles can read usage ledger" on public.enterprise_usage_ledger;
create policy "billing roles can read usage ledger" on public.enterprise_usage_ledger for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=enterprise_usage_ledger.organization_id and m.user_id=(select auth.uid()) and m.role in('owner','admin','billing')));
drop policy if exists "audit roles can read audit logs" on public.enterprise_audit_logs;
create policy "audit roles can read audit logs" on public.enterprise_audit_logs for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=enterprise_audit_logs.organization_id and m.user_id=(select auth.uid()) and m.role in('owner','admin','auditor')));
drop policy if exists "members can read SLA policies" on public.enterprise_sla_policies;
create policy "members can read SLA policies" on public.enterprise_sla_policies for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=enterprise_sla_policies.organization_id and m.user_id=(select auth.uid())));

revoke all on table public.organization_entitlements,public.organization_policies,public.enterprise_teams,public.enterprise_team_members,public.enterprise_invitations,public.enterprise_usage_monthly,public.enterprise_usage_ledger,public.enterprise_audit_logs,public.enterprise_sla_policies from anon,authenticated;
grant select on table public.organization_entitlements,public.organization_policies,public.enterprise_teams,public.enterprise_team_members,public.enterprise_invitations,public.enterprise_usage_monthly,public.enterprise_usage_ledger,public.enterprise_audit_logs,public.enterprise_sla_policies to authenticated;

create or replace function public.enterprise_task_admission() returns trigger language plpgsql security invoker as $$
declare e public.organization_entitlements%rowtype;p public.organization_policies%rowtype;u public.enterprise_usage_monthly%rowtype;period date;
begin
 period:=date_trunc('month',now())::date;perform pg_advisory_xact_lock(hashtext(NEW.organization_id::text));
 insert into public.organization_entitlements(organization_id) values(NEW.organization_id) on conflict(organization_id) do nothing;
 insert into public.organization_policies(organization_id) values(NEW.organization_id) on conflict(organization_id) do nothing;
 select * into e from public.organization_entitlements where organization_id=NEW.organization_id;select * into p from public.organization_policies where organization_id=NEW.organization_id;
 insert into public.enterprise_usage_monthly(organization_id,period_start) values(NEW.organization_id,period) on conflict(organization_id,period_start) do nothing;
 select * into u from public.enterprise_usage_monthly where organization_id=NEW.organization_id and period_start=period for update;
 if NEW.max_cost_cents>e.max_task_cost_cents or NEW.max_cost_cents>p.max_task_cost_cents then raise exception 'Enterprise max task cost exceeded';end if;
 if u.task_count>=e.monthly_task_limit then raise exception 'Enterprise monthly task limit exceeded';end if;
 if u.spend_cents+u.reserved_cents+NEW.max_cost_cents>e.monthly_spend_limit_cents then raise exception 'Enterprise monthly spend ceiling reached';end if;
 NEW.execution_region:=coalesce(NEW.execution_region,e.primary_region);NEW.reservation_period:=period;
 if not(NEW.execution_region=any(e.allowed_regions)) then raise exception 'Execution region is not allowed by enterprise policy';end if;
 update public.enterprise_usage_monthly set task_count=task_count+1,reserved_cents=reserved_cents+NEW.max_cost_cents,updated_at=now() where organization_id=NEW.organization_id and period_start=period;
 return NEW;
end; $$;

create or replace function public.enterprise_task_concurrency() returns trigger language plpgsql security invoker as $$
declare e public.organization_entitlements%rowtype;running_count integer;
begin
 if OLD.status is distinct from NEW.status and NEW.status='running' and OLD.status<>'running' then
  perform pg_advisory_xact_lock(hashtext(NEW.organization_id::text));select * into e from public.organization_entitlements where organization_id=NEW.organization_id;
  select count(*) into running_count from public.tasks where organization_id=NEW.organization_id and status='running' and id<>NEW.id;
  if running_count>=e.max_concurrency then raise exception 'Enterprise concurrency ceiling reached';end if;
 end if;return NEW;
end; $$;

create or replace function public.enterprise_release_reservation() returns trigger language plpgsql security invoker as $$
begin
 if OLD.status not in('verified','failed','cancelled') and NEW.status in('verified','failed','cancelled') then
  update public.enterprise_usage_monthly set reserved_cents=greatest(0,reserved_cents-OLD.max_cost_cents),updated_at=now() where organization_id=NEW.organization_id and period_start=coalesce(OLD.reservation_period,date_trunc('month',coalesce(NEW.completed_at,now()))::date);
 end if;return NEW;
end; $$;

create or replace function public.enterprise_task_budget_immutable() returns trigger language plpgsql security invoker as $$
begin
 if NEW.max_cost_cents is distinct from OLD.max_cost_cents or NEW.reservation_period is distinct from OLD.reservation_period then raise exception 'Task budget reservation is immutable';end if;
 return NEW;
end; $$;

drop trigger if exists enterprise_task_admission_trigger on public.tasks;
create trigger enterprise_task_admission_trigger before insert on public.tasks for each row execute function public.enterprise_task_admission();
drop trigger if exists enterprise_task_concurrency_trigger on public.tasks;
create trigger enterprise_task_concurrency_trigger before update of status on public.tasks for each row execute function public.enterprise_task_concurrency();
drop trigger if exists enterprise_release_reservation_trigger on public.tasks;
create trigger enterprise_release_reservation_trigger after update of status on public.tasks for each row execute function public.enterprise_release_reservation();
drop trigger if exists enterprise_task_budget_immutable_trigger on public.tasks;
create trigger enterprise_task_budget_immutable_trigger before update on public.tasks for each row execute function public.enterprise_task_budget_immutable();

create or replace function public.enterprise_agent_admission() returns trigger language plpgsql security invoker as $$
declare e public.organization_entitlements%rowtype;n integer;
begin
 perform pg_advisory_xact_lock(hashtext(NEW.organization_id::text));select * into e from public.organization_entitlements where organization_id=NEW.organization_id;
 if not found then insert into public.organization_entitlements(organization_id) values(NEW.organization_id) on conflict(organization_id) do nothing;select * into e from public.organization_entitlements where organization_id=NEW.organization_id;end if;
 select count(*) into n from public.agents where organization_id=NEW.organization_id;
 if n>=e.max_agents then raise exception 'Enterprise agent ceiling reached';end if;return NEW;
end; $$;
drop trigger if exists enterprise_agent_admission_trigger on public.agents;
create trigger enterprise_agent_admission_trigger before insert on public.agents for each row execute function public.enterprise_agent_admission();

create or replace function public.enterprise_member_admission() returns trigger language plpgsql security invoker as $$
declare e public.organization_entitlements%rowtype;n integer;
begin
 perform pg_advisory_xact_lock(hashtext(NEW.organization_id::text));select * into e from public.organization_entitlements where organization_id=NEW.organization_id;
 if not found then insert into public.organization_entitlements(organization_id) values(NEW.organization_id) on conflict(organization_id) do nothing;select * into e from public.organization_entitlements where organization_id=NEW.organization_id;end if;
 select count(*) into n from public.organization_members where organization_id=NEW.organization_id;
 if n>=e.max_members then raise exception 'Enterprise member ceiling reached';end if;return NEW;
end; $$;
drop trigger if exists enterprise_member_admission_trigger on public.organization_members;
create trigger enterprise_member_admission_trigger before insert on public.organization_members for each row execute function public.enterprise_member_admission();

create or replace function public.enterprise_immutable_append_only() returns trigger language plpgsql security invoker as $$
begin raise exception 'Enterprise append-only record cannot be updated or deleted';end; $$;
drop trigger if exists enterprise_audit_immutable_trigger on public.enterprise_audit_logs;
create trigger enterprise_audit_immutable_trigger before update or delete on public.enterprise_audit_logs for each row execute function public.enterprise_immutable_append_only();
drop trigger if exists enterprise_usage_immutable_trigger on public.enterprise_usage_ledger;
create trigger enterprise_usage_immutable_trigger before update or delete on public.enterprise_usage_ledger for each row execute function public.enterprise_immutable_append_only();

revoke execute on function public.enterprise_task_admission() from public,anon,authenticated;
revoke execute on function public.enterprise_task_concurrency() from public,anon,authenticated;
revoke execute on function public.enterprise_release_reservation() from public,anon,authenticated;
revoke execute on function public.enterprise_task_budget_immutable() from public,anon,authenticated;
revoke execute on function public.enterprise_agent_admission() from public,anon,authenticated;
revoke execute on function public.enterprise_member_admission() from public,anon,authenticated;
revoke execute on function public.enterprise_immutable_append_only() from public,anon,authenticated;