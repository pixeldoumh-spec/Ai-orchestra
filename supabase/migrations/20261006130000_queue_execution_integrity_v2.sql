-- Queue & Execution Integrity v2
-- Enforce one active delivery and one active worker run per task.
-- Serialize delivery claims by task so different dispatch IDs cannot race.

create unique index if not exists background_delivery_attempts_one_active_task
  on public.background_delivery_attempts(task_id)
  where status='running' and task_id is not null;

create unique index if not exists background_worker_runs_one_active_task
  on public.background_worker_runs(task_id)
  where status='running' and task_id is not null;

create or replace function public.claim_background_delivery(
  p_dispatch_id text,
  p_queue_message_id text,
  p_task_id text,
  p_organization_id uuid,
  p_attempt integer,
  p_worker_id text,
  p_stale_seconds integer default 900,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.background_delivery_attempts%rowtype;
  active_task_delivery public.background_delivery_attempts%rowtype;
  completed_existing boolean;
begin
  if p_dispatch_id is null or length(trim(p_dispatch_id))=0 then
    raise exception 'Invalid dispatch id';
  end if;
  if p_queue_message_id is null or length(trim(p_queue_message_id))=0 then
    raise exception 'Invalid queue message id';
  end if;
  if p_attempt < 1 or p_attempt > 100000 then
    raise exception 'Invalid delivery attempt';
  end if;
  if p_stale_seconds < 30 or p_stale_seconds > 86400 then
    raise exception 'Invalid delivery stale threshold';
  end if;

  -- Same task must serialize delivery claims regardless of dispatch id.
  perform pg_advisory_xact_lock(
    hashtext(p_organization_id::text || ':' || p_task_id)
  );

  select *
    into active_task_delivery
  from public.background_delivery_attempts
  where task_id=p_task_id
    and status='running'
  order by started_at desc, id desc
  limit 1
  for update;

  if found then
    -- The active task delivery is the authoritative queue-execution fence.
    -- Never create a second active delivery for the same task.
    return jsonb_build_object(
      'claimed', false,
      'reason', 'task_execution_already_claimed',
      'dispatchId', p_dispatch_id,
      'activeDispatchId', active_task_delivery.dispatch_id,
      'activeWorkerId', active_task_delivery.worker_id
    );
  end if;

  select *
    into existing
  from public.background_delivery_attempts
  where dispatch_id=p_dispatch_id
    and status in ('running','completed')
  order by id desc
  limit 1
  for update;

  if found and existing.status='running' then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'duplicate_inflight',
      'dispatchId', p_dispatch_id,
      'activeAttempt', existing.attempt
    );
  end if;

  select exists (
    select 1
    from public.background_delivery_attempts
    where dispatch_id=p_dispatch_id
      and status='completed'
  ) into completed_existing;

  if completed_existing then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'duplicate_completed',
      'dispatchId', p_dispatch_id
    );
  end if;

  insert into public.background_delivery_attempts(
    organization_id, task_id, dispatch_id, queue_message_id, attempt, worker_id, status, started_at
  ) values (
    p_organization_id, p_task_id, p_dispatch_id, p_queue_message_id, p_attempt, p_worker_id, 'running', p_now
  )
  returning id into existing.id;

  return jsonb_build_object(
    'claimed', true,
    'reclaimed', false,
    'deliveryId', existing.id,
    'dispatchId', p_dispatch_id,
    'attempt', p_attempt
  );
end;
$$;

revoke all on function public.claim_background_delivery(text,text,text,uuid,integer,text,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_background_delivery(text,text,text,uuid,integer,text,integer,timestamptz) to service_role;

comment on index public.background_delivery_attempts_one_active_task
  is 'Queue integrity: at most one active queue delivery per task.';
comment on index public.background_worker_runs_one_active_task
  is 'Queue integrity: at most one active worker run per task.';
comment on function public.claim_background_delivery(text,text,text,uuid,integer,text,integer,timestamptz)
  is 'Queue integrity: serialize delivery claims per task and suppress cross-dispatch concurrent execution.';
