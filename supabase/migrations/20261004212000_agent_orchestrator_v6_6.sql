-- V6.6 Production Operations
-- Durable execution telemetry, background dispatch state, and tenant-scoped ops aggregates.

alter table public.tasks
  add column if not exists execution_mode text not null default 'background'
    check (execution_mode in ('background','inline')),
  add column if not exists dispatch_count integer not null default 0 check (dispatch_count >= 0),
  add column if not exists last_dispatched_at timestamptz,
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists last_worker_id text;

create index if not exists tasks_background_dispatch_idx
  on public.tasks (status, run_after, lease_until, last_dispatched_at, created_at)
  where status in ('queued','running');

create index if not exists task_events_stream_idx
  on public.task_events (task_id, id);

create table if not exists public.task_execution_metrics (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id text not null,
  step_id text,
  agent_id text,
  provider text not null,
  model text,
  attempt integer not null default 1 check (attempt >= 1),
  turn integer not null default 1 check (turn >= 1),
  status text not null check (status in ('completed','failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  usage_cents bigint not null default 0 check (usage_cents >= 0),
  resource_unit text,
  resource_quantity bigint,
  fallback_from_provider text,
  fallback_from_model text,
  error_class text,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists task_execution_metrics_org_created_idx
  on public.task_execution_metrics (organization_id, created_at desc);
create index if not exists task_execution_metrics_task_created_idx
  on public.task_execution_metrics (task_id, created_at desc);
create index if not exists task_execution_metrics_provider_model_idx
  on public.task_execution_metrics (organization_id, provider, model, created_at desc);

alter table public.task_execution_metrics enable row level security;
drop policy if exists "org members can read execution metrics" on public.task_execution_metrics;
create policy "org members can read execution metrics"
  on public.task_execution_metrics for select to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.organization_id = task_execution_metrics.organization_id
      and m.user_id = (select auth.uid())
  ));
revoke all on table public.task_execution_metrics from anon, authenticated;
grant select on table public.task_execution_metrics to authenticated;

create table if not exists public.background_worker_runs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id text,
  dispatch_id text not null,
  worker_id text not null,
  trigger text not null check (trigger in ('queue','cron','manual')),
  attempt integer not null default 1 check (attempt >= 1),
  status text not null default 'running' check (status in ('running','completed','failed','skipped')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  error_class text,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists background_worker_runs_org_created_idx
  on public.background_worker_runs (organization_id, created_at desc);
create index if not exists background_worker_runs_dispatch_idx
  on public.background_worker_runs (dispatch_id, created_at desc);
create index if not exists background_worker_runs_task_idx
  on public.background_worker_runs (task_id, created_at desc);

alter table public.background_worker_runs enable row level security;
drop policy if exists "org members can read background worker runs" on public.background_worker_runs;
create policy "org members can read background worker runs"
  on public.background_worker_runs for select to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.organization_id = background_worker_runs.organization_id
      and m.user_id = (select auth.uid())
  ));
revoke all on table public.background_worker_runs from anon, authenticated;
grant select on table public.background_worker_runs to authenticated;

create or replace function public.get_operations_dashboard(
  p_organization_id uuid,
  p_since timestamptz default now() - interval '30 days'
)
returns jsonb
language sql
security definer
set search_path = public
as $$
with m as (
  select *
  from public.task_execution_metrics
  where organization_id = p_organization_id
    and created_at >= p_since
),
task_stats as (
  select
    count(*) filter (where status in ('queued','running','awaiting_approval','verified','failed','cancelled'))::bigint as task_count,
    count(*) filter (where status = 'verified')::bigint as verified_count,
    count(*) filter (where status = 'failed')::bigint as failed_count,
    count(*) filter (where status = 'cancelled')::bigint as cancelled_count
  from public.tasks
  where organization_id = p_organization_id
    and created_at >= p_since
),
worker_stats as (
  select
    count(*)::bigint as runs,
    count(*) filter (where status = 'completed')::bigint as completed,
    count(*) filter (where status = 'failed')::bigint as failed,
    coalesce(percentile_cont(0.95) within group (order by latency_ms) filter (where latency_ms is not null), 0)::numeric as p95_latency_ms
  from public.background_worker_runs
  where organization_id = p_organization_id
    and created_at >= p_since
),
model_stats as (
  select
    count(*)::bigint as calls,
    count(*) filter (where status = 'completed')::bigint as successful_calls,
    count(*) filter (where status = 'failed')::bigint as failed_calls,
    count(*) filter (where fallback_from_provider is not null)::bigint as fallback_calls,
    coalesce(sum(input_tokens),0)::bigint as input_tokens,
    coalesce(sum(output_tokens),0)::bigint as output_tokens,
    coalesce(sum(usage_cents),0)::bigint as spend_cents,
    coalesce(sum(resource_quantity) filter (where resource_unit = 'neurons'),0)::bigint as neurons,
    coalesce(percentile_cont(0.50) within group (order by latency_ms) filter (where status = 'completed' and latency_ms is not null), 0)::numeric as p50_latency_ms,
    coalesce(percentile_cont(0.95) within group (order by latency_ms) filter (where status = 'completed' and latency_ms is not null), 0)::numeric as p95_latency_ms
  from m
),
daily as (
  select
    date_trunc('day', created_at)::date as day,
    count(*)::bigint as calls,
    count(*) filter (where status='completed')::bigint as successful_calls,
    count(*) filter (where status='failed')::bigint as failed_calls,
    count(*) filter (where fallback_from_provider is not null)::bigint as fallback_calls,
    coalesce(sum(usage_cents),0)::bigint as spend_cents,
    coalesce(sum(resource_quantity) filter (where resource_unit='neurons'),0)::bigint as neurons
  from m
  group by 1
  order by 1
),
models as (
  select
    provider,
    coalesce(model,'unknown') as model,
    count(*)::bigint as calls,
    count(*) filter (where status='completed')::bigint as successful_calls,
    count(*) filter (where status='failed')::bigint as failed_calls,
    count(*) filter (where fallback_from_provider is not null)::bigint as fallback_calls,
    coalesce(sum(usage_cents),0)::bigint as spend_cents,
    coalesce(sum(resource_quantity) filter (where resource_unit='neurons'),0)::bigint as neurons,
    coalesce(percentile_cont(0.95) within group (order by latency_ms) filter (where status='completed' and latency_ms is not null),0)::numeric as p95_latency_ms
  from m
  group by provider, model
  order by calls desc
)
select jsonb_build_object(
  'summary', (select to_jsonb(model_stats) from model_stats),
  'tasks', (select to_jsonb(task_stats) from task_stats),
  'workers', (select to_jsonb(worker_stats) from worker_stats),
  'daily', coalesce((select jsonb_agg(to_jsonb(daily) order by day) from daily),'[]'::jsonb),
  'models', coalesce((select jsonb_agg(to_jsonb(models) order by calls desc) from models),'[]'::jsonb)
);
$$;

revoke all on function public.get_operations_dashboard(uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.get_operations_dashboard(uuid,timestamptz) to service_role;

comment on table public.task_execution_metrics is 'Append-only V6.6 model execution telemetry. Never stores prompts, outputs or secrets.';
comment on table public.background_worker_runs is 'Durable background dispatch attempt telemetry for V6.6 operations.';
