-- V3: dynamic DAG planning, parallel execution metadata, verification/replanning, and bounded approvals.

alter table public.tasks add column if not exists plan_revision integer not null default 1 check (plan_revision >= 1);
alter table public.tasks add column if not exists replan_count integer not null default 0 check (replan_count >= 0);
alter table public.tasks add column if not exists planner_model text;
alter table public.tasks add column if not exists plan_json jsonb not null default '{}'::jsonb;

alter table public.task_steps add column if not exists kind text not null default 'work' check (kind in ('work','verification'));
alter table public.task_steps add column if not exists verifies text[] not null default '{}';
alter table public.task_steps add column if not exists plan_revision integer not null default 1 check (plan_revision >= 1);
alter table public.task_steps add column if not exists usage_cents_total integer not null default 0 check (usage_cents_total >= 0);

create index if not exists task_steps_plan_revision_idx on public.task_steps(task_id, plan_revision, status, run_after);
create index if not exists tasks_replan_idx on public.tasks(organization_id, status, replan_count, created_at);

-- Preserve audit semantics: events are append-only even for privileged worker connections.
create or replace function public.prevent_task_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'task_events is append-only';
end;
$$;

drop trigger if exists task_events_immutable on public.task_events;
revoke execute on function public.prevent_task_event_mutation() from public, anon, authenticated;

create trigger task_events_immutable
before update or delete on public.task_events
for each row execute function public.prevent_task_event_mutation();

comment on column public.tasks.plan_json is 'Validated V3 workflow plan used to create the current plan revision.';
comment on column public.tasks.replan_count is 'Number of recovery replans performed for this task.';
comment on column public.task_steps.kind is 'work or verification; verification steps can gate task completion.';
comment on column public.task_steps.usage_cents_total is 'Cumulative model spend for all attempts of this step.';