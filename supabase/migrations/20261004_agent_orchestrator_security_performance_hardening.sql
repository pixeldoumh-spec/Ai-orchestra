-- Post-V6 database security and performance hardening.
-- Makes server-only tables explicitly deny browser reads, pins function search_path,
-- and adds covering indexes for foreign keys not already indexed by a left-prefix index.

alter table public.agent_identities enable row level security;
alter table public.agent_identity_keys enable row level security;
alter table public.connector_credentials enable row level security;
alter table public.connector_requests enable row level security;

drop policy if exists "server only agent identities" on public.agent_identities;
create policy "server only agent identities" on public.agent_identities
  for select to anon, authenticated using (false);

drop policy if exists "server only agent identity keys" on public.agent_identity_keys;
create policy "server only agent identity keys" on public.agent_identity_keys
  for select to anon, authenticated using (false);

drop policy if exists "server only connector credentials" on public.connector_credentials;
create policy "server only connector credentials" on public.connector_credentials
  for select to anon, authenticated using (false);

drop policy if exists "server only connector requests" on public.connector_requests;
create policy "server only connector requests" on public.connector_requests
  for select to anon, authenticated using (false);

alter function public.ack_agent_network_message(uuid,text,text,boolean,text,timestamptz)
  set search_path = pg_catalog, public, auth, extensions;
alter function public.agent_network_event_immutable()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.agent_network_message_admission()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.agent_network_message_delete_guard()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.agent_network_message_immutable()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.agent_network_peer_admission()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.claim_agent_network_messages(uuid,text,integer,timestamptz)
  set search_path = pg_catalog, public, auth, extensions;
alter function public.enterprise_agent_admission()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.enterprise_immutable_append_only()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.enterprise_member_admission()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.enterprise_record_usage(uuid,text,text,text,bigint,integer,bigint,text,text)
  set search_path = pg_catalog, public, auth, extensions;
alter function public.enterprise_release_reservation()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.enterprise_task_admission()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.enterprise_task_budget_immutable()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.enterprise_task_concurrency()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.prevent_task_event_mutation()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.record_agent_network_event()
  set search_path = pg_catalog, public, auth, extensions;
alter function public.record_connector_outcome(uuid,uuid,boolean,integer,integer,text,text,timestamptz)
  set search_path = pg_catalog, public, auth, extensions;
alter function public.sync_agent_identity_key()
  set search_path = pg_catalog, public, auth, extensions;

do $$
declare
  fk record;
  cols text;
  idx_name text;
begin
  for fk in
    select c.oid,
           c.conrelid,
           c.conname,
           c.conkey,
           n.nspname as schema_name,
           cls.relname as table_name
    from pg_constraint c
    join pg_class cls on cls.oid = c.conrelid
    join pg_namespace n on n.oid = cls.relnamespace
    where c.contype = 'f'
      and n.nspname = 'public'
  loop
    if not exists (
      select 1
      from pg_index i
      where i.indrelid = fk.conrelid
        and i.indisvalid
        and i.indisready
        and i.indpred is null
        and i.indnkeyatts >= array_length(fk.conkey, 1)
        and (i.indkey::int2[])[1:array_length(fk.conkey, 1)] = fk.conkey
    ) then
      select string_agg(format('%I', a.attname), ', ' order by u.ord)
        into cols
      from unnest(fk.conkey) with ordinality as u(attnum, ord)
      join pg_attribute a
        on a.attrelid = fk.conrelid
       and a.attnum = u.attnum;

      idx_name := left(
        'idx_fk_' || fk.table_name || '_' || md5(fk.conname || ':' || fk.oid::text),
        63
      );

      execute format(
        'create index if not exists %I on public.%I (%s)',
        idx_name,
        fk.table_name,
        cols
      );
    end if;
  end loop;
end $$;

comment on table public.agent_identities is
  'Server-only per-agent signing identities; browser roles are explicitly denied by RLS.';
comment on table public.connector_credentials is
  'Encrypted connector secrets; browser roles are explicitly denied by RLS.';
comment on table public.connector_requests is
  'Server-only signed connector intents with nonce replay protection.';
