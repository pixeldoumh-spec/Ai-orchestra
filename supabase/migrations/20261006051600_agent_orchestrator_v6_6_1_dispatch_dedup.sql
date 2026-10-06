-- V6.6.1: enforce one active delivery per logical dispatch across queue retry attempts.
-- Queue attempts are retries of the same logical message; they must never execute
-- concurrently under different (dispatch_id, attempt) rows.

update public.background_delivery_attempts d
set status='failed',
    completed_at=coalesce(d.completed_at, now()),
    metadata=coalesce(d.metadata,'{}'::jsonb) || jsonb_build_object('recoveredBy','v661_dispatch_dedup_migration')
where d.status='running'
  and exists (
    select 1
    from public.background_delivery_attempts newer
    where newer.dispatch_id=d.dispatch_id
      and newer.status='running'
      and (newer.started_at > d.started_at or (newer.started_at=d.started_at and newer.id>d.id))
  );

update public.background_worker_runs r
set status='failed',
    completed_at=coalesce(r.completed_at, now()),
    latency_ms=greatest(0, extract(epoch from (coalesce(r.completed_at, now()) - r.started_at))::integer * 1000),
    error_class='integrity',
    error_code='duplicate_dispatch_active',
    metadata=coalesce(r.metadata,'{}'::jsonb) || jsonb_build_object('recoveredBy','v661_dispatch_dedup_migration')
where r.status='running'
  and exists (
    select 1
    from public.background_worker_runs newer
    where newer.dispatch_id=r.dispatch_id
      and newer.status='running'
      and (newer.started_at > r.started_at or (newer.started_at=r.started_at and newer.id>r.id))
  );

create unique index if not exists background_delivery_one_active_dispatch
  on public.background_delivery_attempts(dispatch_id)
  where status='running';

create unique index if not exists background_delivery_one_active_message
  on public.background_delivery_attempts(queue_message_id)
  where status='running';

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
set search_path=public
as $function$
declare
  existing public.background_delivery_attempts%rowtype;
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

  perform pg_advisory_xact_lock(hashtext(p_dispatch_id));

  select *
    into existing
  from public.background_delivery_attempts
  where dispatch_id=p_dispatch_id
    and status='running'
  order by started_at desc, id desc
  limit 1
  for update;

  if found then
    if existing.started_at > p_now - make_interval(secs => p_stale_seconds) then
      return jsonb_build_object(
        'claimed', false,
        'reason', 'duplicate_inflight',
        'dispatchId', p_dispatch_id,
        'activeAttempt', existing.attempt
      );
    end if;

    update public.background_delivery_attempts
       set organization_id=p_organization_id,
           task_id=p_task_id,
           queue_message_id=p_queue_message_id,
           attempt=p_attempt,
           worker_id=p_worker_id,
           status='running',
           started_at=p_now,
           completed_at=null,
           error_class=null,
           error_code=null,
           metadata=jsonb_build_object(
             'reclaimed', true,
             'previousAttempt', existing.attempt,
             'previousWorkerId', existing.worker_id
           )
     where id=existing.id;

    return jsonb_build_object(
      'claimed', true,
      'reclaimed', true,
      'deliveryId', existing.id,
      'dispatchId', p_dispatch_id,
      'attempt', p_attempt
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
$function$;

revoke all on function public.claim_background_delivery(text,text,text,uuid,integer,text,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_background_delivery(text,text,text,uuid,integer,text,integer,timestamptz) to service_role;
