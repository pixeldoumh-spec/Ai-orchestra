-- V6.6.1: terminal task -> terminal current steps invariant.
-- A task cannot remain terminal while its current plan revision contains
-- queued/running/awaiting_approval steps.

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

    update public.task_steps
       set status = 'cancelled',
           finished_at = coalesce(finished_at, now()),
           updated_at = now(),
           error = coalesce(error, 'Task entered terminal state; unresolved step cancelled by runtime invariant')
     where task_id = NEW.id
       and plan_revision = NEW.plan_revision
       and status in ('queued','running','awaiting_approval');
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

comment on function public.enforce_task_lease_invariant()
is 'V6.6.1 terminal task/lease/current-step invariant enforcement';
