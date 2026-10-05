-- V7 quota dashboard hardening: include current agent/member usage in the snapshot.

create or replace function public.get_product_quota_snapshot(p_organization_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
with period as (
  select date_trunc('month',now())::date as period_start
),
e as (
  select * from public.organization_entitlements where organization_id=p_organization_id
),
u as (
  select * from public.enterprise_usage_monthly where organization_id=p_organization_id and period_start=(select period_start from period)
),
runtime as (
  select count(*) filter (where status='running')::bigint as running_tasks
  from public.tasks where organization_id=p_organization_id
),
agent_usage as (
  select count(*)::bigint as used from public.agents where organization_id=p_organization_id
),
member_usage as (
  select count(*)::bigint as used from public.organization_members where organization_id=p_organization_id
)
select jsonb_build_object(
  'plan', coalesce((select plan from e),'starter'),
  'periodStart', (select period_start from period),
  'tasks', jsonb_build_object('used',coalesce((select task_count from u),0),'limit',coalesce((select monthly_task_limit from e),0)),
  'spend', jsonb_build_object('usedCents',coalesce((select spend_cents from u),0),'reservedCents',coalesce((select reserved_cents from u),0),'limitCents',coalesce((select monthly_spend_limit_cents from e),0)),
  'agents', jsonb_build_object('used',coalesce((select used from agent_usage),0),'limit',coalesce((select max_agents from e),0)),
  'members', jsonb_build_object('used',coalesce((select used from member_usage),0),'limit',coalesce((select max_members from e),0)),
  'concurrency', jsonb_build_object('running',coalesce((select running_tasks from runtime),0),'limit',coalesce((select max_concurrency from e),0)),
  'maxTaskCostCents',coalesce((select max_task_cost_cents from e),0),
  'features',coalesce((select features from e),'{}'::jsonb)
);
$$;

revoke all on function public.get_product_quota_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.get_product_quota_snapshot(uuid) to service_role;
