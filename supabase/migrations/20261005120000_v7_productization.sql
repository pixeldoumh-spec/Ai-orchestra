-- V7 Productization
-- Plans, billing ledger, quota reservations, team governance and connector marketplace.

alter table public.organization_entitlements
  add column if not exists max_connectors integer not null default 2 check (max_connectors > 0);

create table if not exists public.plan_catalog (
  id text primary key,
  name text not null,
  description text not null default '',
  monthly_price_cents bigint not null default 0 check (monthly_price_cents >= 0),
  annual_price_cents bigint not null default 0 check (annual_price_cents >= 0),
  monthly_task_limit bigint not null check (monthly_task_limit > 0),
  monthly_spend_limit_cents bigint not null check (monthly_spend_limit_cents >= 0),
  max_agents integer not null check (max_agents > 0),
  max_members integer not null check (max_members > 0),
  max_concurrency integer not null check (max_concurrency > 0),
  max_task_cost_cents bigint not null check (max_task_cost_cents >= 0),
  max_connectors integer not null check (max_connectors > 0),
  features jsonb not null default '{}'::jsonb,
  stripe_monthly_price_id text,
  stripe_annual_price_id text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

insert into public.plan_catalog(id,name,description,monthly_price_cents,annual_price_cents,monthly_task_limit,monthly_spend_limit_cents,max_agents,max_members,max_concurrency,max_task_cost_cents,max_connectors,features,sort_order)
values
 ('free','Free','For personal exploration and small workloads.',0,0,100,1000,4,2,1,250,2,'{"teams":false,"audit":true,"usage":true,"marketplace":true,"priority_support":false}',10),
 ('pro','Pro','For serious individual builders and autonomous workloads.',1900,19000,5000,25000,20,5,5,5000,10,'{"teams":true,"audit":true,"usage":true,"marketplace":true,"priority_support":false}',20),
 ('team','Team','For collaborative teams running production agents.',7900,79000,25000,150000,50,25,15,25000,50,'{"teams":true,"audit":true,"usage":true,"marketplace":true,"priority_support":true}',30),
 ('enterprise','Enterprise','For governed organizations with custom limits and controls.',29900,299000,100000,1000000,200,200,50,100000,200,'{"teams":true,"audit":true,"usage":true,"marketplace":true,"priority_support":true,"sso":true,"scim":true,"regional_failover":true}',40)
on conflict (id) do update set
 name=excluded.name,description=excluded.description,monthly_price_cents=excluded.monthly_price_cents,annual_price_cents=excluded.annual_price_cents,
 monthly_task_limit=excluded.monthly_task_limit,monthly_spend_limit_cents=excluded.monthly_spend_limit_cents,max_agents=excluded.max_agents,max_members=excluded.max_members,
 max_concurrency=excluded.max_concurrency,max_task_cost_cents=excluded.max_task_cost_cents,max_connectors=excluded.max_connectors,features=excluded.features,sort_order=excluded.sort_order;

-- Keep existing V5/V6 organizations compatible with the V7 catalog.
update public.organization_entitlements e
set max_connectors = coalesce((p.features->>'max_connectors')::integer, e.max_connectors)
from public.plan_catalog p
where p.id=e.plan;

create table if not exists public.billing_customers (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null default 'stripe',
  provider_customer_id text unique,
  billing_email text,
  currency text not null default 'usd',
  tax_country text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'stripe',
  provider_subscription_id text unique,
  plan_id text not null references public.plan_catalog(id),
  status text not null check (status in ('trialing','active','past_due','paused','cancelled','incomplete')),
  billing_interval text not null check (billing_interval in ('month','year')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists billing_subscriptions_one_live_idx on public.billing_subscriptions(organization_id) where status in ('trialing','active','past_due','paused','incomplete');

create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'stripe',
  provider_invoice_id text unique,
  subscription_id uuid references public.billing_subscriptions(id) on delete set null,
  status text not null check (status in ('draft','open','paid','void','uncollectible','failed')),
  amount_due_cents bigint not null default 0 check (amount_due_cents >= 0),
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),
  currency text not null default 'usd',
  hosted_invoice_url text,
  invoice_pdf_url text,
  period_start timestamptz,
  period_end timestamptz,
  issued_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billing_invoices_org_idx on public.billing_invoices(organization_id, created_at desc);

create table if not exists public.billing_events (
  id bigint generated always as identity primary key,
  provider text not null,
  provider_event_id text not null unique,
  event_type text not null,
  organization_id uuid references public.organizations(id) on delete set null,
  payload_hash text not null,
  processed_at timestamptz not null default now(),
  status text not null default 'processed' check (status in ('processed','ignored','failed')),
  error_message text
);

create table if not exists public.quota_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  idempotency_key text not null,
  estimated_cost_cents bigint not null check (estimated_cost_cents >= 0),
  status text not null default 'reserved' check (status in ('reserved','committed','released','expired')),
  task_id text,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  unique(organization_id,idempotency_key)
);
create index if not exists quota_reservations_org_status_idx on public.quota_reservations(organization_id,status,created_at desc);

create table if not exists public.connector_marketplace_catalog (
  id text primary key,
  slug text not null unique,
  name text not null,
  publisher text not null,
  description text not null default '',
  category text not null default 'general',
  adapter_key text not null,
  auth_scheme text not null check (auth_scheme in ('none','bearer','api_key','hmac')),
  capabilities jsonb not null default '[]'::jsonb,
  scopes jsonb not null default '[]'::jsonb,
  configuration_schema jsonb not null default '{}'::jsonb,
  pricing jsonb not null default '{}'::jsonb,
  verified boolean not null default false,
  active boolean not null default true,
  version text not null default '1.0.0',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.connector_marketplace_catalog(id,slug,name,publisher,description,category,adapter_key,auth_scheme,capabilities,scopes,configuration_schema,verified,version)
values ('http-webhook','http-webhook','HTTP Webhook','INBOX9','Generic HTTPS connector for approved external APIs and webhooks.','automation','http','api_key','["http.request","external.action"]','["read","write"]','{"baseUrl":{"type":"url","required":true},"credential":{"type":"secret","required":false}}',true,'1.0.0')
on conflict (id) do update set description=excluded.description,capabilities=excluded.capabilities,scopes=excluded.scopes,configuration_schema=excluded.configuration_schema,updated_at=now();

create table if not exists public.connector_marketplace_installations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  catalog_id text not null references public.connector_marketplace_catalog(id),
  connector_id uuid references public.connectors(id) on delete set null,
  status text not null default 'installed' check (status in ('installed','disabled','uninstalled','pending_configuration')),
  installed_by uuid,
  config jsonb not null default '{}'::jsonb,
  installed_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,catalog_id)
);
create index if not exists connector_marketplace_installations_org_idx on public.connector_marketplace_installations(organization_id,status);

alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_events enable row level security;
alter table public.quota_reservations enable row level security;
alter table public.connector_marketplace_catalog enable row level security;
alter table public.connector_marketplace_installations enable row level security;

drop policy if exists "org members can read billing customers" on public.billing_customers;
create policy "org members can read billing customers" on public.billing_customers for select to authenticated using (exists(select 1 from public.organization_members m where m.organization_id=billing_customers.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "org members can read billing subscriptions" on public.billing_subscriptions;
create policy "org members can read billing subscriptions" on public.billing_subscriptions for select to authenticated using (exists(select 1 from public.organization_members m where m.organization_id=billing_subscriptions.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "org members can read billing invoices" on public.billing_invoices;
create policy "org members can read billing invoices" on public.billing_invoices for select to authenticated using (exists(select 1 from public.organization_members m where m.organization_id=billing_invoices.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "catalog is public" on public.connector_marketplace_catalog;
create policy "catalog is public" on public.connector_marketplace_catalog for select to authenticated using (active=true);
drop policy if exists "org members can read marketplace installs" on public.connector_marketplace_installations;
create policy "org members can read marketplace installs" on public.connector_marketplace_installations for select to authenticated using (exists(select 1 from public.organization_members m where m.organization_id=connector_marketplace_installations.organization_id and m.user_id=(select auth.uid())));
revoke all on public.billing_customers,public.billing_subscriptions,public.billing_invoices,public.billing_events,public.quota_reservations,public.connector_marketplace_catalog,public.connector_marketplace_installations from anon,authenticated;
grant select on public.billing_customers,public.billing_subscriptions,public.billing_invoices,public.connector_marketplace_catalog,public.connector_marketplace_installations to authenticated;

create or replace function public.v7_reserve_task_quota(p_organization_id uuid,p_idempotency_key text,p_estimated_cost_cents bigint)
returns jsonb language plpgsql security definer set search_path=public as $v7$
declare ent record; usage record; existing record; active_connectors bigint; reservation_id uuid;
begin
 select * into ent from organization_entitlements where organization_id=p_organization_id for update;
 if not found then raise exception 'Organization plan is not initialized'; end if;
 select coalesce(task_count,0) as task_count,coalesce(spend_cents,0) as spend_cents,coalesce(reserved_cents,0) as reserved_cents into usage from enterprise_usage_monthly where organization_id=p_organization_id and period_start=date_trunc('month',now())::date for update;
 if not found then insert into enterprise_usage_monthly(organization_id,period_start,task_count,spend_cents,reserved_cents) values(p_organization_id,date_trunc('month',now())::date,0,0,0) returning task_count,spend_cents,reserved_cents into usage; end if;
 select * into existing from quota_reservations where organization_id=p_organization_id and idempotency_key=p_idempotency_key and status='reserved' and expires_at>now();
 if found then return jsonb_build_object('allowed',true,'reservationId',existing.id,'status','reserved'); end if;
 if usage.task_count >= ent.monthly_task_limit then raise exception 'Monthly task quota exceeded'; end if;
 if usage.spend_cents + usage.reserved_cents + p_estimated_cost_cents > ent.monthly_spend_limit_cents then raise exception 'Monthly spend quota exceeded'; end if;
 if p_estimated_cost_cents > ent.max_task_cost_cents then raise exception 'Task cost exceeds plan limit'; end if;
 select count(*) into active_connectors from connectors where organization_id=p_organization_id and status<>'disabled';
 if active_connectors >= ent.max_connectors then raise exception 'Connector quota exceeded'; end if;
 insert into quota_reservations(organization_id,idempotency_key,estimated_cost_cents) values(p_organization_id,p_idempotency_key,p_estimated_cost_cents) returning id into reservation_id;
 update enterprise_usage_monthly set reserved_cents=coalesce(reserved_cents,0)+p_estimated_cost_cents where organization_id=p_organization_id and period_start=date_trunc('month',now())::date;
 return jsonb_build_object('allowed',true,'reservationId',reservation_id,'status','reserved');
end;
$v7$;

create or replace function public.v7_commit_task_quota(p_reservation_id uuid,p_task_id text)
returns void language plpgsql security definer set search_path=public as $v7$
declare r record;
begin
 select * into r from quota_reservations where id=p_reservation_id for update;
 if not found then raise exception 'Quota reservation not found'; end if;
 if r.status='committed' then return; end if;
 if r.status<>'reserved' then raise exception 'Quota reservation is not active'; end if;
 update quota_reservations set status='committed',task_id=p_task_id,committed_at=now() where id=r.id;
 update enterprise_usage_monthly set reserved_cents=greatest(0,coalesce(reserved_cents,0)-r.estimated_cost_cents),task_count=task_count+1 where organization_id=r.organization_id and period_start=date_trunc('month',now())::date;
end;
$v7$;

create or replace function public.v7_release_task_quota(p_reservation_id uuid)
returns void language plpgsql security definer set search_path=public as $v7$
declare r record;
begin
 select * into r from quota_reservations where id=p_reservation_id for update;
 if not found or r.status<>'reserved' then return; end if;
 update quota_reservations set status='released' where id=r.id;
 update enterprise_usage_monthly set reserved_cents=greatest(0,coalesce(reserved_cents,0)-r.estimated_cost_cents) where organization_id=r.organization_id and period_start=date_trunc('month',now())::date;
end;
$v7$;

revoke all on function public.v7_reserve_task_quota(uuid,text,bigint),public.v7_commit_task_quota(uuid,text),public.v7_release_task_quota(uuid) from public,anon,authenticated;
grant execute on function public.v7_reserve_task_quota(uuid,text,bigint),public.v7_commit_task_quota(uuid,text),public.v7_release_task_quota(uuid) to service_role;

comment on table public.billing_events is 'Idempotent payment-provider webhook ledger; raw payment secrets are never stored.';
comment on table public.quota_reservations is 'Short-lived atomic V7 task quota reservations keyed by tenant and idempotency key.';
comment on table public.connector_marketplace_catalog is 'Verified connector packages available to tenant administrators.';
