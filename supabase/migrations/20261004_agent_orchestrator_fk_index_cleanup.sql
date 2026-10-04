-- Clean up redundant FK indexes from the initial hardening pass.
-- Keep only the three covering indexes still identified by the Supabase advisor.

do $$
declare
  idx record;
begin
  for idx in
    select i.indexrelid::regclass::text as index_name
    from pg_index i
    join pg_class c on c.oid=i.indexrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
      and c.relname like 'idx_fk_%'
  loop
    execute format('drop index if exists %s', idx.index_name);
  end loop;
end $$;

create index if not exists agent_network_events_message_id_idx
  on public.agent_network_events(message_id);

create index if not exists connector_health_events_connector_id_idx
  on public.connector_health_events(connector_id);

create index if not exists organization_members_user_id_idx
  on public.organization_members(user_id);
