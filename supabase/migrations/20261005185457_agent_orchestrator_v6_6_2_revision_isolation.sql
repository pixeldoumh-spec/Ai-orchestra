-- V6.6.2 Revision isolation
-- Historical task-step rows must never be requeued into the active plan after worker takeover.

create or replace function public.recover_stale_task_steps(
  p_task_id text,
  p_organization_id uuid,
  p_current_lease_generation bigint,
  p_now timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  recovered integer := 0;
  current_revision bigint;
begin
  select t.plan_revision
    into current_revision
  from public.tasks t
  where t.id=p_task_id
    and t.organization_id=p_organization_id
    and t.status='running'
    and t.lease_generation=p_current_lease_generation;

  if current_revision is null then
    return 0;
  end if;

  update public.task_steps s
     set status='queued',
         run_after=p_now,
         error=null,
         finished_at=null
   where s.task_id=p_task_id
     and s.plan_revision=current_revision
     and s.status='running'
     and (
       s.execution_lease_generation is null
       or s.execution_lease_generation is distinct from p_current_lease_generation
     );

  get diagnostics recovered=row_count;
  return recovered;
end;
$$;

revoke all on function public.recover_stale_task_steps(text,uuid,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.recover_stale_task_steps(text,uuid,bigint,timestamptz) to service_role;

comment on function public.recover_stale_task_steps(text,uuid,bigint,timestamptz)
  is 'Requeues stale running steps only within the task''s active plan revision after a new lease is acquired.';
