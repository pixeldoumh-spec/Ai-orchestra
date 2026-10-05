-- V6.6.1 Runtime Integrity
-- Lease fencing, stale-worker recovery, atomic dispatch reservation, and DLQ telemetry.

alter table public.tasks
  add column if not exists lease_generation bigint not null default 0 check (lease_generation >= 0),
  add column if not exists last_lease_acquired_at timestamptz;

create index if not exists tasks_runtime_integrity_idx
  on public.tasks (status, execution_mode, run_after, lease_until, last_heartbeat_at, last_dispatched_at, created_at)
  where status in ('queued','running');

create or replace function public.enforce_task_lease_invariant()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if NEW.status = 'running' and (NEW.lease_owner is null or NEW.lease_until is null) then
    NEW.status := 'queued';
    NEW.run_after := coalesce(NEW.run_after, now() + interval '1 second');
    NEW.lease_owner := null;
    NEW.lease_until := null;
    NEW.last_worker_id := coalesce(NEW.last_worker_id, OLD.last_worker_id);
  elsif NEW.status <> 'running' then
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
    if t.lease_until is not null and t.lease_until > p_now then return null; end if;
    if t.last_heartbeat_at is not null
       and t.last_heartbeat_at > p_now - make_interval(secs => p_stale_heartbeat_seconds)
    then
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

create or replace function public.heartbeat_task_lease(
  p_task_id text,
  p_organization_id uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_lease_seconds integer default 600,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  until_at timestamptz;
  updated_row public.tasks%rowtype;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'Invalid lease duration';
  end if;

  until_at := p_now + make_interval(secs => p_lease_seconds);

  update public.tasks
  set lease_until=until_at,
      last_heartbeat_at=p_now,
      last_worker_id=p_worker_id,
      updated_at=p_now
  where id=p_task_id
    and organization_id=p_organization_id
    and status='running'
    and lease_owner=p_worker_id
    and lease_generation=p_lease_generation
  returning * into updated_row;

  if not found then
    raise exception 'Task lease lost';
  end if;

  return jsonb_build_object(
    'taskId', updated_row.id,
    'leaseUntil', until_at,
    'leaseGeneration', updated_row.lease_generation
  );
end;
$$;

create or replace function public.settle_task_lease(
  p_task_id text,
  p_organization_id uuid,
  p_worker_id text,
  p_lease_generation bigint,
  p_requeue_delay_seconds integer default 1,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.tasks%rowtype;
  final_status text;
  next_run_after timestamptz;
begin
  if p_requeue_delay_seconds < 0 or p_requeue_delay_seconds > 300 then
    raise exception 'Invalid requeue delay';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || p_task_id));
  select * into t
  from public.tasks
  where id=p_task_id and organization_id=p_organization_id
  for update;

  if not found then return null; end if;
  if t.lease_owner is distinct from p_worker_id or t.lease_generation is distinct from p_lease_generation then
    return null;
  end if;

  if t.status='running' then
    final_status := 'queued';
    next_run_after := coalesce(t.run_after, p_now + make_interval(secs => p_requeue_delay_seconds));
    update public.tasks
    set status='queued',
        run_after=next_run_after,
        lease_owner=null,
        lease_until=null,
        updated_at=p_now
    where id=t.id;
  else
    final_status := t.status;
    update public.tasks
    set lease_owner=null,
        lease_until=null,
        updated_at=p_now
    where id=t.id;
  end if;

  return jsonb_build_object(
    'taskId', t.id,
    'status', final_status,
    'requeued', t.status='running',
    'runAfter', next_run_after
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
    if t.lease_until is not null and t.lease_until > p_now then return null; end if;
    if t.last_heartbeat_at is not null
       and t.last_heartbeat_at > p_now - make_interval(secs => p_stale_heartbeat_seconds)
    then
      return null;
    end if;
    previous_status := t.status;
    update public.tasks
    set status='queued',
        run_after=p_now,
        lease_owner=null,
        lease_until=null,
        updated_at=p_now
    where id=t.id;
    repaired := true;
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

create table if not exists public.background_dead_letters (
  id bigint generated always as identity primary key,
  organization_id uuid,
  task_id text,
  dispatch_id text,
  queue_message_id text not null,
  attempts integer not null default 1 check (attempts >= 1),
  reason text not null,
  payload_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  replayed_at timestamptz
);

create index if not exists background_dead_letters_org_created_idx
  on public.background_dead_letters (organization_id, created_at desc);
create index if not exists background_dead_letters_task_created_idx
  on public.background_dead_letters (task_id, created_at desc);

alter table public.background_dead_letters enable row level security;
drop policy if exists "org members can read background dead letters" on public.background_dead_letters;
create policy "org members can read background dead letters"
  on public.background_dead_letters for select to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.organization_id=background_dead_letters.organization_id
      and m.user_id=(select auth.uid())
  ));
revoke all on table public.background_dead_letters from anon,authenticated;
grant select on table public.background_dead_letters to authenticated;

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
    organization_id,task_id,dispatch_id,queue_message_id,attempts,reason,payload_hash,metadata
  )
  values(
    p_organization_id,p_task_id,p_dispatch_id,p_queue_message_id,
    greatest(1,p_attempts),left(p_reason,500),nullif(left(coalesce(p_payload_hash,''),64),''),
    coalesce(p_metadata,'{}'::jsonb)
  )
  returning id into out_id;
  return out_id;
end;
$$;

revoke all on function public.claim_task_lease(text,uuid,text,integer,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.heartbeat_task_lease(text,uuid,text,bigint,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.settle_task_lease(text,uuid,text,bigint,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.reserve_task_dispatch(text,uuid,text,integer,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.record_background_dead_letter(uuid,text,text,text,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.claim_task_lease(text,uuid,text,integer,integer,timestamptz) to service_role;
grant execute on function public.heartbeat_task_lease(text,uuid,text,bigint,integer,timestamptz) to service_role;
grant execute on function public.settle_task_lease(text,uuid,text,bigint,integer,timestamptz) to service_role;
grant execute on function public.reserve_task_dispatch(text,uuid,text,integer,integer,timestamptz) to service_role;
grant execute on function public.record_background_dead_letter(uuid,text,text,text,integer,text,text,jsonb) to service_role;

comment on column public.tasks.lease_generation is 'Monotonic fencing token preventing stale workers from mutating newer task leases.';
comment on table public.background_dead_letters is 'Durable metadata for task messages that exhausted queue delivery retries; never stores prompts or secrets.';
