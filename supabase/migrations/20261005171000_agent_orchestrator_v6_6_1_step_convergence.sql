-- V6.6.1 final convergence: fence and recover step executions across task lease generations.

alter table public.task_steps
  add column if not exists execution_worker_id text,
  add column if not exists execution_lease_generation bigint;

create index if not exists task_steps_running_execution_idx
  on public.task_steps (task_id, status, execution_lease_generation)
  where status = 'running';

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
declare recovered integer := 0;
begin
  update public.task_steps s
     set status='queued',
         run_after=p_now,
         error=null,
         finished_at=null
   where s.task_id=p_task_id
     and s.status='running'
     and (
       s.execution_lease_generation is null
       or s.execution_lease_generation is distinct from p_current_lease_generation
     )
     and exists (
       select 1
       from public.tasks t
       where t.id=p_task_id
         and t.organization_id=p_organization_id
         and t.status='running'
         and t.lease_generation=p_current_lease_generation
     );
  get diagnostics recovered=row_count;
  return recovered;
end;
$$;

revoke all on function public.recover_stale_task_steps(text,uuid,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.recover_stale_task_steps(text,uuid,bigint,timestamptz) to service_role;

comment on column public.task_steps.execution_worker_id is 'Worker that most recently owned a running execution attempt.';
comment on column public.task_steps.execution_lease_generation is 'Task lease generation under which the running execution attempt started.';
comment on function public.recover_stale_task_steps(text,uuid,bigint,timestamptz) is 'Requeues running steps belonging to an older or unknown worker generation after a new task lease is acquired.';
