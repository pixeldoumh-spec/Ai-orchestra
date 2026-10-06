-- Queue & Execution Integrity hardening
-- Lease expiry is the sole takeover boundary. Heartbeat staleness is telemetry,
-- not permission to create a second execution while the lease is still active.

create or replace function public.claim_task_lease(
  p_task_id text,
  p_organization_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 600,
  p_stale_heartbeat_seconds integer default 120,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.tasks%rowtype;
  next_generation bigint;
  until_at timestamptz;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'Invalid lease duration';
  end if;
  if p_stale_heartbeat_seconds < 30 or p_stale_heartbeat_seconds > 1800 then
    raise exception 'Invalid stale heartbeat duration';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || p_task_id));
  select * into t
  from public.tasks
  where id=p_task_id and organization_id=p_organization_id
  for update;

  if not found then return null; end if;
  if t.status in ('awaiting_approval','verified','failed','cancelled') then return null; end if;
  if t.run_after is not null and t.run_after > p_now then return null; end if;

  if t.status='running' then
    -- Never take over an active lease. The worker may be inside a long model
    -- call and its heartbeat can legitimately be delayed.
    if t.lease_until is not null and t.lease_until > p_now then
      return null;
    end if;
  elsif t.status <> 'queued' then
    return null;
  elsif t.lease_until is not null and t.lease_until > p_now then
    return null;
  end if;

  next_generation := coalesce(t.lease_generation,0) + 1;
  until_at := p_now + make_interval(secs => p_lease_seconds);

  update public.tasks
  set status='running',
      lease_owner=p_worker_id,
      lease_until=until_at,
      lease_generation=next_generation,
      started_at=coalesce(started_at,p_now),
      last_heartbeat_at=p_now,
      last_worker_id=p_worker_id,
      last_lease_acquired_at=p_now,
      run_after=null,
      updated_at=p_now
  where id=p_task_id and organization_id=p_organization_id;

  return jsonb_build_object(
    'taskId', t.id,
    'organizationId', t.organization_id,
    'status', 'running',
    'workerId', p_worker_id,
    'leaseOwner', p_worker_id,
    'leaseUntil', until_at,
    'leaseGeneration', next_generation
  );
end;
$$;

create or replace function public.reserve_task_dispatch(
  p_task_id text,
  p_organization_id uuid,
  p_dispatch_id text,
  p_dispatch_cooldown_seconds integer default 45,
  p_stale_heartbeat_seconds integer default 120,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.tasks%rowtype;
  previous_status text;
  repaired boolean := false;
begin
  if p_dispatch_cooldown_seconds < 1 or p_dispatch_cooldown_seconds > 600 then
    raise exception 'Invalid dispatch cooldown';
  end if;
  if p_stale_heartbeat_seconds < 30 or p_stale_heartbeat_seconds > 1800 then
    raise exception 'Invalid stale heartbeat duration';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || p_task_id));
  select * into t
  from public.tasks
  where id=p_task_id
    and organization_id=p_organization_id
    and execution_mode='background'
  for update;

  if not found then return null; end if;
  if t.status not in ('queued','running') then return null; end if;
  if t.run_after is not null and t.run_after > p_now then return null; end if;
  if t.last_dispatched_at is not null
     and t.last_dispatched_at > p_now - make_interval(secs => p_dispatch_cooldown_seconds)
  then
    return null;
  end if;

  if t.status='queued' then
    if t.lease_until is not null and t.lease_until > p_now then return null; end if;
  else
    -- Running tasks may only be redriven after the execution lease expires.
    if t.lease_until is not null and t.lease_until > p_now then return null; end if;
    previous_status:=t.status;
    update public.tasks
    set status='queued',
        run_after=p_now,
        lease_owner=null,
        lease_until=null,
        updated_at=p_now
    where id=t.id;
    repaired:=true;
  end if;

  update public.tasks
  set dispatch_count=dispatch_count+1,
      last_dispatched_at=p_now,
      last_dispatch_id=p_dispatch_id,
      updated_at=p_now
  where id=t.id;

  return jsonb_build_object(
    'taskId', t.id,
    'organizationId', t.organization_id,
    'dispatchId', p_dispatch_id,
    'previousStatus', coalesce(previous_status,t.status),
    'repairedStaleRunning', repaired
  );
end;
$$;

create or replace function public.sweep_runtime_integrity(
  p_stale_lease_seconds integer default 300,
  p_stale_worker_run_seconds integer default 900,
  p_max_tasks integer default 25,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  -- Lease expiry is the only task-recovery boundary. Do not requeue a task
  -- merely because a heartbeat is old while its lease remains active.
  for t in
    select id, organization_id, lease_owner, lease_generation
      from public.tasks
     where status = 'running'
       and (lease_until is null or lease_until <= p_now)
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
        'reason', 'expired_task_lease',
        'previousWorkerId', t.lease_owner,
        'previousLeaseGeneration', t.lease_generation
      )
    );

    recovered_ids := recovered_ids || to_jsonb(t.id);
    recovered_count := recovered_count + 1;
  end loop;

  -- A running delivery stays active while its task lease is still owned by
  -- the same worker/dispatch. Once the lease expires or ownership changes,
  -- the row becomes recoverable telemetry.
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
     );
  get diagnostics closed_deliveries = row_count;

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
$$;

revoke all on function public.claim_task_lease(text,uuid,text,integer,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.reserve_task_dispatch(text,uuid,text,integer,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.sweep_runtime_integrity(integer,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_task_lease(text,uuid,text,integer,integer,timestamptz) to service_role;
grant execute on function public.reserve_task_dispatch(text,uuid,text,integer,integer,timestamptz) to service_role;
grant execute on function public.sweep_runtime_integrity(integer,integer,integer,timestamptz) to service_role;

comment on function public.claim_task_lease(text,uuid,text,integer,integer,timestamptz)
  is 'Queue integrity: lease expiry is the sole takeover boundary; stale heartbeat never creates concurrent task execution.';
comment on function public.reserve_task_dispatch(text,uuid,text,integer,integer,timestamptz)
  is 'Queue integrity: background redrive never resets an actively leased task.';
comment on function public.sweep_runtime_integrity(integer,integer,integer,timestamptz)
  is 'Queue integrity: runtime sweeper only recovers expired leases and stale execution telemetry.';
