-- V7 Productization: plans, billing, quotas, collaboration, connector marketplace, enterprise administration.

create table if not exists public.product_plans (
  code text primary key check (code ~ '^[a-z][a-z0-9_-]{1,40}$'),
  name text not null check (char_length(name) between 2 and 80),
  description text not null default '' check (char_length(description) <= 500),
  billing_mode text not null default 'free' check (billing_mode in ('free','fixed','custom')),
  currency text not null default 'usd' check (currency = lower(currency) and char_length(currency) = 3),
  monthly_price_cents bigint,
  annual_price_cents bigint,
  stripe_monthly_price_id text,
  stripe_annual_price_id text,
  monthly_task_limit integer not null check (monthly_task_limit between 1 and 100000000),
  monthly_spend_limit_cents bigint not null check (monthly_spend_limit_cents >= 0),
  max_agents integer not null check (max_agents between 1 and 10000),
  max_members integer not null check (max_members between 1 and 100000),
  max_concurrency integer not null check (max_concurrency between 1 and 10000),
  max_task_cost_cents integer not null check (max_task_cost_cents >= 0),
  retention_days integer not null check (retention_days between 1 and 3650),
  alert_threshold_percent integer not null default 80 check (alert_threshold_percent between 1 and 100),
  features jsonb not null default '{}'::jsonb,
  published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.product_plans (
  code,name,description,billing_mode,currency,monthly_price_cents,annual_price_cents,
  monthly_task_limit,monthly_spend_limit_cents,max_agents,max_members,max_concurrency,
  max_task_cost_cents,retention_days,alert_threshold_percent,features
) values
  ('starter','Starter','Core orchestration for an individual workspace.','free','usd',0,0,
   1000,50000,20,10,5,5000,30,80,
   '{"teams":true,"usage":true,"audit":true,"marketplace":false,"advanced_connectors":false,"sso":false,"scim":false}'::jsonb),
  ('team','Team','Shared workspaces with collaboration and connector marketplace access.','fixed','usd',null,null,
   10000,500000,100,50,20,25000,90,80,
   '{"teams":true,"usage":true,"audit":true,"marketplace":true,"advanced_connectors":true,"sso":false,"scim":false}'::jsonb),
  ('enterprise','Enterprise','High-scale governance, collaboration and enterprise administration.','custom','usd',null,null,
   100000,5000000,1000,1000,100,500000,365,75,
   '{"teams":true,"usage":true,"audit":true,"marketplace":true,"advanced_connectors":true,"sso":true,"scim":true}'::jsonb)
on conflict (code) do update set
  name=excluded.name,
  description=excluded.description,
  billing_mode=excluded.billing_mode,
  currency=excluded.currency,
  updated_at=now();

alter table public.product_plans enable row level security;
drop policy if exists "authenticated users can read published plans" on public.product_plans;
create policy "authenticated users can read published plans"
  on public.product_plans for select to authenticated
  using (published = true);
revoke all on table public.product_plans from anon, authenticated;
grant select on table public.product_plans to authenticated;

create table if not exists public.billing_customers (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('stripe','manual')),
  external_customer_id text unique,
  email text check (email is null or char_length(email) between 3 and 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_code text not null references public.product_plans(code),
  provider text not null check (provider in ('stripe','manual')),
  external_subscription_id text unique,
  status text not null check (status in ('trialing','active','incomplete','incomplete_expired','past_due','canceled','unpaid','paused')),
  interval text not null default 'month' check (interval in ('month','year','manual')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  customer_external_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billing_subscriptions_org_idx
  on public.billing_subscriptions (organization_id, updated_at desc);
create index if not exists billing_subscriptions_status_idx
  on public.billing_subscriptions (organization_id, status);

create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid references public.billing_subscriptions(id) on delete set null,
  provider text not null check (provider in ('stripe','manual')),
  external_invoice_id text not null unique,
  status text not null,
  currency text not null,
  amount_due_cents bigint not null default 0 check (amount_due_cents >= 0),
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),
  hosted_invoice_url text,
  period_start timestamptz,
  period_end timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billing_invoices_org_idx
  on public.billing_invoices (organization_id, created_at desc);

create table if not exists public.billing_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe','manual')),
  external_event_id text not null unique,
  event_type text not null,
  payload_hash text not null check (char_length(payload_hash)=64),
  status text not null default 'received' check (status in ('received','processed','failed','ignored')),
  error text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists billing_events_status_idx
  on public.billing_events (status, received_at desc);

alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_events enable row level security;

drop policy if exists "billing roles can read customers" on public.billing_customers;
create policy "billing roles can read customers" on public.billing_customers for select to authenticated
  using (exists (select 1 from public.organization_members m where m.organization_id=billing_customers.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','admin','billing')));
drop policy if exists "billing roles can read subscriptions" on public.billing_subscriptions;
create policy "billing roles can read subscriptions" on public.billing_subscriptions for select to authenticated
  using (exists (select 1 from public.organization_members m where m.organization_id=billing_subscriptions.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','admin','billing')));
drop policy if exists "billing roles can read invoices" on public.billing_invoices;
create policy "billing roles can read invoices" on public.billing_invoices for select to authenticated
  using (exists (select 1 from public.organization_members m where m.organization_id=billing_invoices.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','admin','billing')));
revoke all on table public.billing_customers,public.billing_subscriptions,public.billing_invoices,public.billing_events from anon, authenticated;
grant select on table public.billing_customers,public.billing_subscriptions,public.billing_invoices to authenticated;

create or replace function public.apply_product_plan(p_organization_id uuid, p_plan_code text)
returns public.organization_entitlements
language plpgsql
security definer
set search_path = public
as $$
declare
  plan public.product_plans%rowtype;
  out_row public.organization_entitlements%rowtype;
begin
  select * into plan from public.product_plans where code=p_plan_code and published=true;
  if not found then raise exception 'Product plan not found: %', p_plan_code; end if;

  insert into public.organization_entitlements (organization_id)
  values (p_organization_id)
  on conflict (organization_id) do nothing;

  update public.organization_entitlements
  set plan=plan.code,
      monthly_task_limit=plan.monthly_task_limit,
      monthly_spend_limit_cents=plan.monthly_spend_limit_cents,
      max_agents=plan.max_agents,
      max_members=plan.max_members,
      max_concurrency=plan.max_concurrency,
      max_task_cost_cents=plan.max_task_cost_cents,
      retention_days=plan.retention_days,
      alert_threshold_percent=plan.alert_threshold_percent,
      features=plan.features,
      updated_at=now()
  where organization_id=p_organization_id
  returning * into out_row;

  return out_row;
end;
$$;

revoke all on function public.apply_product_plan(uuid,text) from public, anon, authenticated;
grant execute on function public.apply_product_plan(uuid,text) to service_role;

alter table public.tasks add column if not exists team_id uuid references public.enterprise_teams(id) on delete set null;
create index if not exists tasks_team_idx on public.tasks (team_id, created_at desc);

create or replace function public.validate_task_team() returns trigger
language plpgsql security invoker as $$
begin
  if new.team_id is not null and not exists (
    select 1 from public.enterprise_teams t
    where t.id=new.team_id and t.organization_id=new.organization_id
  ) then
    raise exception 'Task team must belong to the task organization';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_task_team_trigger on public.tasks;
create trigger validate_task_team_trigger before insert or update of team_id,organization_id on public.tasks
for each row execute function public.validate_task_team();

create table if not exists public.task_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id text not null references public.tasks(id) on delete cascade,
  team_id uuid references public.enterprise_teams(id) on delete set null,
  author_id uuid not null references auth.users(id) on delete restrict,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists task_comments_task_idx on public.task_comments (task_id, created_at asc);
create index if not exists task_comments_org_idx on public.task_comments (organization_id, created_at desc);

alter table public.task_comments enable row level security;
drop policy if exists "org members can read task comments" on public.task_comments;
create policy "org members can read task comments"
  on public.task_comments for select to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.organization_id=task_comments.organization_id and m.user_id=(select auth.uid())
  ));
revoke all on table public.task_comments from anon, authenticated;
grant select on table public.task_comments to authenticated;

create or replace function public.validate_task_comment() returns trigger
language plpgsql security invoker as $$
begin
  if not exists (
    select 1 from public.tasks t
    where t.id=new.task_id and t.organization_id=new.organization_id
  ) then
    raise exception 'Task comment tenant boundary failed';
  end if;
  if new.team_id is not null and not exists (
    select 1 from public.enterprise_teams t
    where t.id=new.team_id and t.organization_id=new.organization_id
  ) then
    raise exception 'Comment team must belong to the task organization';
  end if;
  return new;
end;
$$;
drop trigger if exists validate_task_comment_trigger on public.task_comments;
create trigger validate_task_comment_trigger before insert on public.task_comments
for each row execute function public.validate_task_comment();

revoke execute on function public.validate_task_team() from public,anon,authenticated;
revoke execute on function public.validate_task_comment() from public,anon,authenticated;

create table if not exists public.connector_marketplace_catalog (
  slug text primary key check (slug ~ '^[a-z][a-z0-9_-]{1,60}$'),
  name text not null check (char_length(name) between 2 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  category text not null check (char_length(category) between 2 and 80),
  kind text not null check (kind in ('http','reserved')),
  base_url text,
  auth_scheme text not null check (auth_scheme in ('none','bearer','api_key','hmac')),
  version text not null,
  categories text[] not null default '{}',
  manifest jsonb not null default '{}'::jsonb,
  published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (base_url is null or base_url like 'https://%')
);

insert into public.connector_marketplace_catalog
  (slug,name,description,category,kind,base_url,auth_scheme,version,categories,manifest)
values
  ('github-rest','GitHub REST','Tenant-owned GitHub REST connector. Credential and agent binding are required before execution.','Developer','http','https://api.github.com','bearer','1.0.0',array['git','issues','pull-requests'],
   '{"requires_credential":true,"approval_for_writes":true,"execution_mode":"application-owned-http"}'::jsonb),
  ('slack-web-api','Slack Web API','Tenant-owned Slack Web API connector. Credential and agent binding are required before execution.','Collaboration','http','https://slack.com/api','bearer','1.0.0',array['messages','teams'],
   '{"requires_credential":true,"approval_for_writes":true,"execution_mode":"application-owned-http"}'::jsonb),
  ('generic-https','Generic HTTPS','Bring your own HTTPS API endpoint. Configure the base URL and optional credential after installation.','Developer','http',null,'none','1.0.0',array['custom','rest'],
   '{"requires_credential":false,"approval_for_writes":true,"execution_mode":"application-owned-http","requires_base_url":true}'::jsonb)
on conflict (slug) do update set
  name=excluded.name,
  description=excluded.description,
  category=excluded.category,
  kind=excluded.kind,
  base_url=excluded.base_url,
  auth_scheme=excluded.auth_scheme,
  version=excluded.version,
  categories=excluded.categories,
  manifest=excluded.manifest,
  updated_at=now();

alter table public.connector_marketplace_catalog enable row level security;
drop policy if exists "authenticated users can read connector catalog" on public.connector_marketplace_catalog;
create policy "authenticated users can read connector catalog" on public.connector_marketplace_catalog
  for select to authenticated using (published=true);
revoke all on table public.connector_marketplace_catalog from anon, authenticated;
grant select on table public.connector_marketplace_catalog to authenticated;

create table if not exists public.organization_connector_installs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  catalog_slug text not null references public.connector_marketplace_catalog(slug),
  connector_id uuid not null references public.connectors(id) on delete cascade,
  installed_version text not null,
  status text not null default 'active' check (status in ('active','uninstalled')),
  installed_by uuid references auth.users(id) on delete set null,
  installed_at timestamptz not null default now(),
  uninstalled_at timestamptz,
  unique(organization_id,catalog_slug)
);
create index if not exists organization_connector_installs_org_idx
  on public.organization_connector_installs (organization_id,status);

alter table public.organization_connector_installs enable row level security;
drop policy if exists "org members can read connector installs" on public.organization_connector_installs;
create policy "org members can read connector installs" on public.organization_connector_installs
  for select to authenticated
  using (exists (select 1 from public.organization_members m where m.organization_id=organization_connector_installs.organization_id and m.user_id=(select auth.uid())));
revoke all on table public.organization_connector_installs from anon, authenticated;
grant select on table public.organization_connector_installs to authenticated;

create or replace function public.get_product_quota_snapshot(p_organization_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
with period as (
  select date_trunc('month',now())::date as period_start
),
e as (
  select * from public.organization_entitlements where organization_id=p_organization_id
),
u as (
  select * from public.enterprise_usage_monthly where organization_id=p_organization_id and period_start=(select period_start from period)
),
runtime as (
  select count(*) filter (where status='running')::bigint as running_tasks
  from public.tasks where organization_id=p_organization_id
)
select jsonb_build_object(
  'plan', coalesce((select plan from e),'starter'),
  'periodStart', (select period_start from period),
  'tasks', jsonb_build_object('used',coalesce((select task_count from u),0),'limit',coalesce((select monthly_task_limit from e),0)),
  'spend', jsonb_build_object('usedCents',coalesce((select spend_cents from u),0),'reservedCents',coalesce((select reserved_cents from u),0),'limitCents',coalesce((select monthly_spend_limit_cents from e),0)),
  'agents', jsonb_build_object('limit',coalesce((select max_agents from e),0)),
  'members', jsonb_build_object('limit',coalesce((select max_members from e),0)),
  'concurrency', jsonb_build_object('running',coalesce((select running_tasks from runtime),0),'limit',coalesce((select max_concurrency from e),0)),
  'maxTaskCostCents',coalesce((select max_task_cost_cents from e),0),
  'features',coalesce((select features from e),'{}'::jsonb)
);
$$;
revoke all on function public.get_product_quota_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.get_product_quota_snapshot(uuid) to service_role;

comment on table public.product_plans is 'V7 published product plan catalog; subscription provisioning copies limits into organization_entitlements.';
comment on table public.billing_events is 'V7 idempotent Stripe/manual billing event ledger; payload is service-role only.';
comment on table public.organization_connector_installs is 'V7 marketplace installation metadata. Installing a manifest never grants credentials or unrestricted tool authority.';
comment on table public.task_comments is 'V7 tenant-scoped collaboration comments; append-only user discussion attached to tasks.';
