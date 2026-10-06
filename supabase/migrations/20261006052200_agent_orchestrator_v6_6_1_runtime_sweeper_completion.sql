-- V6.6.1: make the runtime sweeper a complete cleanup boundary.
-- Stale queue-delivery rows must not remain "running" after their task has
-- moved to another lease generation or reached a terminal state.

create or replace function public.sweep_runtime_integrity(
  p_stale_lease_seconds integer default 300,
  p_stale_worker_run_seconds integer default 900,
  p_max_tasks integer default 25,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $function$
declare
  t record;
  recovered_ids jsonb := '[]'::jsonb;
  recovered_count integer := 0;
  closed_runs integer := 0;
  closed_deliveries integer := 0;
begin
  if p_stale_lease_seconds < 30 or p_stale_lease_seconds > 86400 then
    raise exception 'Invalid stale lease threshold';
  end if;
  if p_stale_worker_run_seconds < 30 or p_stale_worker_run_seconds > 86400 then
    raise exception 'Invalid stale worker run threshold';
  end if;
  if p_max_tasks < 1 or p_max_tasks > 100 then
    raise exception 'Invalid sweep task limit';
  end if;

  for t in
    select id, organization_id, lease_owner, lease_generation
      from public.tasks
     where status = 'running'
       and (
         lease_until is null
         or lease_until <= p_now
         or last_heartbeat_at is null
         or last_heartbeat_at <= p_now - make_interval(secs => p_stale_lease_seconds)
       )
     order by updated_at asc
     for update skip locked
     limit p_max_tasks
  loop
    update public.tasks
       set status='queued',
           run_after=p_now,
           lease_owner=null,
           lease_until=null,
           updated_at=p_now
     where id=t.id;

    insert into public.task_events(task_id, organization_id, event_type, actor_type, actor_id, payload)
    values (
      t.id,
      t.organization_id,
      'task.operational_recovery',
      'system',
      'runtime_sweeper',
      jsonb_build_object(
        'reason', 'stale_task_lease',
        'previousWorkerId', t.lease_owner,
        'previousLeaseGeneration', t.lease_generation
      )
    );

    recovered_ids := recovered_ids || to_jsonb(t.id);
    recovered_count := recovered_count + 1;
  end loop;

  -- Close delivery rows that outlived their worker attempt without a fresh
  -- matching task lease. This prevents historical delivery attempts from
  -- polluting active-runtime health checks.
  update public.background_delivery_attempts d
     set status='failed',
         completed_at=coalesce(d.completed_at, p_now),
         metadata=coalesce(d.metadata, '{}'::jsonb)
           || jsonb_build_object(
                'recoveredBy','runtime_sweeper',
                'reason','stale_delivery_attempt'
              )
   where d.status='running'
     and d.started_at <= p_now - make_interval(secs => p_stale_worker_run_seconds)
     and not exists (
       select 1
       from public.tasks t2
       where t2.id=d.task_id
         and t2.status='running'
         and t2.lease_owner=d.worker_id
         and t2.last_dispatch_id=d.dispatch_id
         and t2.lease_until > p_now
         and t2.last_heartbeat_at is not null
         and t2.last_heartbeat_at > p_now - make_interval(secs => p_stale_lease_seconds)
     );
  get diagnostics closed_deliveries = row_count;

  -- Close worker-run records using the same task-ownership fence.
  update public.background_worker_runs r
     set status='failed',
         completed_at=p_now,
         latency_ms=greatest(
           0,
           extract(epoch from (p_now - r.started_at))::integer * 1000
         ),
         error_class='sweeper',
         error_code='stuck_run_recovered',
         metadata=coalesce(r.metadata, '{}'::jsonb)
           || jsonb_build_object('recoveredBy','runtime_sweeper')
   where r.status='running'
     and r.started_at <= p_now - make_interval(secs => p_stale_worker_run_seconds)
     and not exists (
       select 1
       from public.tasks t2
       where t2.id=r.task_id
         and t2.status='running'
         and t2.lease_owner=r.worker_id
         and t2.last_dispatch_id=r.dispatch_id
         and t2.lease_until > p_now
         and t2.last_heartbeat_at is not null
         and t2.last_heartbeat_at > p_now - make_interval(secs => p_stale_lease_seconds)
     );
  get diagnostics closed_runs = row_count;

  return jsonb_build_object(
    'recoveredTaskIds', recovered_ids,
    'recoveredCount', recovered_count,
    'closedWorkerRuns', closed_runs,
    'closedDeliveries', closed_deliveries,
    'sweptAt', p_now
  );
end;
$function$;

revoke all on function public.sweep_runtime_integrity(integer,integer,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.sweep_runtime_integrity(integer,integer,integer,timestamptz) to service_role;
