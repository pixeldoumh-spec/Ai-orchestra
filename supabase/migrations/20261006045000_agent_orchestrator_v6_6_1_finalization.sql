-- V6.6.1 finalization: durable lease invariants, runtime sweeper,
-- duplicate delivery fencing, and idempotent DLQ replay.

create or replace function public.enforce_task_lease_invariant()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE'
     and OLD.status in ('verified','failed','cancelled')
     and NEW.status is distinct from OLD.status then
    raise exception 'Terminal task is immutable';
  end if;

  if NEW.status in ('verified','failed','cancelled') then
    NEW.completed_at := coalesce(NEW.completed_at, now());
    NEW.lease_owner := null;
    NEW.lease_until := null;
    NEW.run_after := null;
  elsif NEW.status = 'running' then
    NEW.completed_at := null;
    if NEW.lease_owner is null or NEW.lease_until is null then
      NEW.status := 'queued';
      NEW.run_after := coalesce(NEW.run_after, now() + interval '1 second');
      NEW.lease_owner := null;
      NEW.lease_until := null;
    end if;
  else
    NEW.completed_at := null;
    NEW.lease_owner := null;
    NEW.lease_until := null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists task_lease_invariant_trigger on public.tasks;
create trigger task_lease_invariant_trigger
before insert or update on public.tasks
for each row execute function public.enforce_task_lease_invariant();

alter table public.tasks
  drop constraint if exists tasks_terminal_state_invariant;

alter table public.tasks
  add constraint tasks_terminal_state_invariant
  check (
    (status in ('verified','failed','cancelled') and completed_at is not null)
    or
    (status not in ('verified','failed','cancelled') and completed_at is null)
  );

create table if not exists public.background_delivery_attempts (
  id bigint generated always as identity primary key,
  organization_id uuid,
  task_id text,
  dispatch_id text not null,
  queue_message_id text not null,
  attempt integer not null check (attempt >= 1),
  worker_id text not null,
  status text not null default 'running'
    check (status = any (array['running'::text,'completed'::text,'failed'::text,'skipped'::text])),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (dispatch_id, attempt)
);

create index if not exists background_delivery_attempts_task_idx
  on public.background_delivery_attempts (task_id, created_at desc);
create index if not exists background_delivery_attempts_queue_message_idx
  on public.background_delivery_attempts (queue_message_id, attempt);

alter table public.background_delivery_attempts enable row level security;
drop policy if exists "org members can read background delivery attempts" on public.background_delivery_attempts;
create policy "org members can read background delivery attempts"
  on public.background_delivery_attempts for select to authenticated
  using (
    organization_id is not null
    and exists (
      select 1 from public.organization_members m
      where m.organization_id = background_delivery_attempts.organization_id
        and m.user_id = (select auth.uid())
    )
  );
revoke all on table public.background_delivery_attempts from anon, authenticated;
grant select on table public.background_delivery_attempts to authenticated;

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
  is_stale boolean := false;
begin
  if p_attempt < 1 or p_attempt > 100000 then
    raise exception 'Invalid delivery attempt';
  end if;
  if p_stale_seconds < 30 or p_stale_seconds > 86400 then
    raise exception 'Invalid delivery stale threshold';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_dispatch_id || ':' || p_attempt::text));

  select *
    into existing
  from public.background_delivery_attempts
  where dispatch_id = p_dispatch_id
    and attempt = p_attempt
  for update;

  if found then
    if existing.status = 'completed' then
      return jsonb_build_object('claimed', false, 'reason', 'duplicate_completed');
    elsif existing.status = 'skipped' then
      return jsonb_build_object('claimed', false, 'reason', 'duplicate_skipped');
    elsif existing.status = 'failed' then
      return jsonb_build_object('claimed', false, 'reason', 'duplicate_failed');
    end if;

    is_stale := existing.started_at <= p_now - make_interval(secs => p_stale_seconds);
    if not is_stale then
      return jsonb_build_object('claimed', false, 'reason', 'duplicate_inflight');
    end if;

    update public.background_delivery_attempts
      set organization_id = p_organization_id,
          task_id = p_task_id,
          queue_message_id = p_queue_message_id,
          worker_id = p_worker_id,
          status = 'running',
          started_at = p_now,
          completed_at = null,
          metadata = jsonb_build_object('reclaimed', true, 'previousWorkerId', existing.worker_id)
      where id = existing.id;

    return jsonb_build_object(
      'claimed', true,
      'reclaimed', true,
      'deliveryId', existing.id,
      'dispatchId', p_dispatch_id,
      'attempt', p_attempt
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

create or replace function public.finish_background_delivery(
  p_dispatch_id text,
  p_attempt integer,
  p_worker_id text,
  p_status text,
  p_metadata jsonb default '{}'::jsonb,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data public.background_delivery_attempts%rowtype;
begin
  if p_status not in ('completed','failed','skipped') then
    raise exception 'Invalid delivery finish status';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_dispatch_id || ':' || p_attempt::text));

  select *
    into row_data
  from public.background_delivery_attempts
  where dispatch_id = p_dispatch_id
    and attempt = p_attempt
  for update;

  if not found then
    return jsonb_build_object('updated', false, 'reason', 'delivery_not_found');
  end if;

  if row_data.status <> 'running' then
    return jsonb_build_object('updated', false, 'reason', 'already_finished', 'status', row_data.status);
  end if;

  if row_data.worker_id is distinct from p_worker_id then
    return jsonb_build_object('updated', false, 'reason', 'delivery_fenced');
  end if;

  update public.background_delivery_attempts
    set status = p_status,
        completed_at = p_now,
        metadata = coalesce(p_metadata, '{}'::jsonb)
    where id = row_data.id;

  return jsonb_build_object('updated', true, 'status', p_status);
end;
$$;

create unique index if not exists background_dead_letters_queue_message_uidx
  on public.background_dead_letters (queue_message_id);

alter table public.background_dead_letters
  add column if not exists replay_claimed_at timestamptz,
  add column if not exists replay_dispatch_id text,
  add column if not exists replay_count integer not null default 0 check (replay_count >= 0);

create index if not exists background_dead_letters_replay_idx
  on public.background_dead_letters (replay_claimed_at, replayed_at);

create or replace function public.record_background_dead_letter(
  p_organization_id uuid,
  p_task_id text,
  p_dispatch_id text,
  p_queue_message_id text,
  p_attempts integer,
  p_reason text,
  p_payload_hash text,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  out_id bigint;
begin
  insert into public.background_dead_letters(
    organization_id, task_id, dispatch_id, queue_message_id, attempts, reason, payload_hash, metadata
  )
  values (
    p_organization_id, p_task_id, p_dispatch_id, p_queue_message_id,
    greatest(1, p_attempts), left(p_reason, 500),
    nullif(left(coalesce(p_payload_hash, ''), 64), ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (queue_message_id) do update set
    organization_id = excluded.organization_id,
    task_id = excluded.task_id,
    dispatch_id = excluded.dispatch_id,
    attempts = greatest(public.background_dead_letters.attempts, excluded.attempts),
    reason = excluded.reason,
    payload_hash = excluded.payload_hash,
    metadata = excluded.metadata
  returning id into out_id;

  return out_id;
end;
$$;

create or replace function public.claim_background_dead_letter_replay(
  p_id bigint,
  p_new_dispatch_id text,
  p_stale_seconds integer default 600,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data public.background_dead_letters%rowtype;
begin
  if p_stale_seconds < 30 or p_stale_seconds > 86400 then
    raise exception 'Invalid replay stale threshold';
  end if;

  perform pg_advisory_xact_lock(hashtext('dlq:' || p_id::text));

  select *
    into row_data
  from public.background_dead_letters
  where id = p_id
  for update;

  if not found or row_data.replayed_at is not null then
    return null;
  end if;

  if row_data.replay_claimed_at is not null
     and row_data.replay_claimed_at > p_now - make_interval(secs => p_stale_seconds)
  then
    return null;
  end if;

  update public.background_dead_letters
    set replay_claimed_at = p_now,
        replay_dispatch_id = p_new_dispatch_id,
        replay_count = replay_count + 1
    where id = row_data.id;

  return jsonb_build_object(
    'id', row_data.id,
    'organizationId', row_data.organization_id,
    'taskId', row_data.task_id,
    'dispatchId', row_data.dispatch_id,
    'queueMessageId', row_data.queue_message_id,
    'attempts', row_data.attempts,
    'reason', row_data.reason,
    'newDispatchId', p_new_dispatch_id
  );
end;
$$;

create or replace function public.mark_background_dead_letter_replayed(
  p_id bigint,
  p_dispatch_id text,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.background_dead_letters
     set replayed_at = coalesce(replayed_at, p_now)
   where id = p_id
     and replayed_at is null
     and replay_dispatch_id = p_dispatch_id;

  return found;
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
         or (
           last_heartbeat_at is not null
           and last_heartbeat_at <= p_now - make_interval(secs => p_stale_lease_seconds)
         )
       )
     order by updated_at asc
     for update skip locked
     limit p_max_tasks
  loop
    update public.tasks
       set status = 'queued',
           run_after = p_now,
           lease_owner = null,
           lease_until = null,
           updated_at = p_now
     where id = t.id;

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

  update public.background_worker_runs r
     set status = 'failed',
         completed_at = p_now,
         latency_ms = greatest(0, extract(epoch from (p_now - r.started_at))::integer * 1000),
         error_class = 'sweeper',
         error_code = 'stuck_run_recovered',
         metadata = coalesce(r.metadata, '{}'::jsonb) || jsonb_build_object('recoveredBy', 'runtime_sweeper')
   where r.status = 'running'
     and r.started_at <= p_now - make_interval(secs => p_stale_worker_run_seconds)
     and not exists (
       select 1
       from public.tasks t2
       where t2.id = r.task_id
         and t2.status = 'running'
         and t2.lease_owner = r.worker_id
         and t2.lease_until > p_now
         and (
           t2.last_heartbeat_at is null
           or t2.last_heartbeat_at > p_now - make_interval(secs => p_stale_lease_seconds)
         )
     );
  get diagnostics closed_runs = row_count;

  return jsonb_build_object(
    'recoveredTaskIds', recovered_ids,
    'recoveredCount', recovered_count,
    'closedWorkerRuns', closed_runs,
    'sweptAt', p_now
  );
end;
$$;

revoke all on function public.claim_background_delivery(text,text,text,uuid,integer,text,integer,timestamptz) from public, anon, authenticated;
revoke all on function public.finish_background_delivery(text,integer,text,text,jsonb,timestamptz) from public, anon, authenticated;
revoke all on function public.claim_background_dead_letter_replay(bigint,text,integer,timestamptz) from public, anon, authenticated;
revoke all on function public.mark_background_dead_letter_replayed(bigint,text,timestamptz) from public, anon, authenticated;
revoke all on function public.sweep_runtime_integrity(integer,integer,integer,timestamptz) from public, anon, authenticated;

grant execute on function public.claim_background_delivery(text,text,text,uuid,integer,text,integer,timestamptz) to service_role;
grant execute on function public.finish_background_delivery(text,integer,text,text,jsonb,timestamptz) to service_role;
grant execute on function public.claim_background_dead_letter_replay(bigint,text,integer,timestamptz) to service_role;
grant execute on function public.mark_background_dead_letter_replayed(bigint,text,timestamptz) to service_role;
grant execute on function public.sweep_runtime_integrity(integer,integer,integer,timestamptz) to service_role;

comment on table public.background_delivery_attempts is 'V6.6.1 duplicate-delivery fence. One dispatch/attempt may be actively processed by only one worker at a time.';
comment on function public.sweep_runtime_integrity(integer,integer,integer,timestamptz) is 'V6.6.1 runtime sweeper for stale task leases and abandoned background worker telemetry.';
