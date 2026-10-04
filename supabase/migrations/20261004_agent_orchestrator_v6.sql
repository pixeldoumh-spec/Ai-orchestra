-- V6: durable, signed, encrypted and policy-bounded agent-to-agent network.
create table if not exists public.agent_identity_keys(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,agent_id text not null,key_version integer not null check(key_version>=1),public_key text not null,fingerprint text not null check(char_length(fingerprint)=64),status text not null default 'active' check(status in('active','revoked')),created_at timestamptz not null default now(),unique(organization_id,agent_id,key_version),
 constraint agent_identity_keys_agent_fk foreign key(organization_id,agent_id) references public.agents(organization_id,id) on delete cascade
);
insert into public.agent_identity_keys(organization_id,agent_id,key_version,public_key,fingerprint,status)
select organization_id,agent_id,key_version,public_key,identity_fingerprint,status from public.agent_identities
on conflict(organization_id,agent_id,key_version) do nothing;
create or replace function public.sync_agent_identity_key() returns trigger language plpgsql security invoker as $$
begin
 insert into public.agent_identity_keys(organization_id,agent_id,key_version,public_key,fingerprint,status) values(NEW.organization_id,NEW.agent_id,NEW.key_version,NEW.public_key,NEW.identity_fingerprint,NEW.status)
 on conflict(organization_id,agent_id,key_version) do update set public_key=excluded.public_key,fingerprint=excluded.fingerprint,status=excluded.status;return NEW;
end; $$;
drop trigger if exists agent_identity_key_history_trigger on public.agent_identities;
create trigger agent_identity_key_history_trigger after insert or update of public_key,key_version,identity_fingerprint,status on public.agent_identities for each row execute function public.sync_agent_identity_key();

create table if not exists public.agent_network_peers(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,source_agent_id text not null,target_agent_id text not null,status text not null default 'active' check(status in('active','revoked')),
 allowed_message_types text[] not null check(array_length(allowed_message_types,1)>0),allowed_scopes text[] not null check(array_length(allowed_scopes,1)>0),max_payload_bytes integer not null default 65536 check(max_payload_bytes between 1024 and 65536),rate_limit_per_minute integer not null default 60 check(rate_limit_per_minute between 1 and 600),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(organization_id,source_agent_id,target_agent_id),
 constraint agent_network_peer_source_fk foreign key(organization_id,source_agent_id) references public.agents(organization_id,id) on delete cascade,constraint agent_network_peer_target_fk foreign key(organization_id,target_agent_id) references public.agents(organization_id,id) on delete cascade,check(source_agent_id<>target_agent_id)
);
create index if not exists agent_network_peers_target_idx on public.agent_network_peers(organization_id,target_agent_id,status);

create table if not exists public.agent_network_messages(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete cascade,message_id text not null unique,nonce text not null,sender_agent_id text not null,target_agent_id text not null,conversation_id text not null,correlation_id text,reply_to_message_id text,
 kind text not null check(kind in('request','response','event','delegation')),scope text not null check(char_length(scope) between 1 and 120),subject text not null check(char_length(subject) between 1 and 200),
 payload_ciphertext text not null,payload_iv text not null,payload_auth_tag text not null,payload_key_version integer not null check(payload_key_version>=1),payload_hash text not null check(char_length(payload_hash)=64),payload_size_bytes integer not null check(payload_size_bytes between 1 and 65536),
 signature text not null,signer_key_version integer not null check(signer_key_version>=1),signer_fingerprint text not null check(char_length(signer_fingerprint)=64),status text not null default 'queued' check(status in('queued','delivered','acknowledged','failed','expired','rejected')),
 priority integer not null default 50 check(priority between 0 and 100),attempt_count integer not null default 0 check(attempt_count>=0),available_at timestamptz not null default now(),expires_at timestamptz not null,delivered_at timestamptz,acked_at timestamptz,last_error text,last_actor_agent_id text,created_at timestamptz not null default now(),
 constraint agent_network_message_sender_fk foreign key(organization_id,sender_agent_id) references public.agents(organization_id,id) on delete cascade,constraint agent_network_message_target_fk foreign key(organization_id,target_agent_id) references public.agents(organization_id,id) on delete cascade,unique(organization_id,sender_agent_id,nonce),
 check(sender_agent_id<>target_agent_id),check(expires_at>created_at),check(expires_at<=created_at+interval '1 hour')
);
create index if not exists agent_network_messages_inbox_idx on public.agent_network_messages(organization_id,target_agent_id,status,priority desc,created_at);
create index if not exists agent_network_messages_sender_idx on public.agent_network_messages(organization_id,sender_agent_id,created_at desc);
create index if not exists agent_network_messages_conversation_idx on public.agent_network_messages(organization_id,conversation_id,created_at);

create table if not exists public.agent_network_events(
 id bigint generated always as identity primary key,organization_id uuid not null references public.organizations(id) on delete cascade,message_id uuid not null references public.agent_network_messages(id) on delete cascade,event_type text not null,actor_agent_id text,status text not null,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now()
);
create index if not exists agent_network_events_message_idx on public.agent_network_events(organization_id,message_id,created_at desc);
alter table public.agent_identity_keys enable row level security;alter table public.agent_network_peers enable row level security;alter table public.agent_network_messages enable row level security;alter table public.agent_network_events enable row level security;
drop policy if exists "org members can read agent network peers" on public.agent_network_peers;
create policy "org members can read agent network peers" on public.agent_network_peers for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=agent_network_peers.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "org members can read agent network messages" on public.agent_network_messages;
create policy "org members can read agent network messages" on public.agent_network_messages for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=agent_network_messages.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "org members can read agent network events" on public.agent_network_events;
create policy "org members can read agent network events" on public.agent_network_events for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=agent_network_events.organization_id and m.user_id=(select auth.uid())));
revoke all on table public.agent_identity_keys,public.agent_network_peers,public.agent_network_messages,public.agent_network_events from anon,authenticated;
grant select on table public.agent_network_peers,public.agent_network_messages,public.agent_network_events to authenticated;

create or replace function public.agent_network_peer_admission() returns trigger language plpgsql security invoker as $$
begin
 if NEW.status='active' and not('request'=any(NEW.allowed_message_types) or 'response'=any(NEW.allowed_message_types) or 'event'=any(NEW.allowed_message_types) or 'delegation'=any(NEW.allowed_message_types)) then raise exception 'Peer must allow at least one known message type';end if;
 return NEW;
end; $$;
drop trigger if exists agent_network_peer_admission_trigger on public.agent_network_peers;
create trigger agent_network_peer_admission_trigger before insert or update on public.agent_network_peers for each row execute function public.agent_network_peer_admission();

create or replace function public.agent_network_message_admission() returns trigger language plpgsql security invoker as $$
declare p public.agent_network_peers%rowtype;k public.agent_identity_keys%rowtype;sent_count integer;
begin
 if NEW.status<>'queued' then raise exception 'Network messages must enter through queued state';end if;
 if NEW.expires_at<=NEW.created_at or NEW.expires_at>NEW.created_at+interval '1 hour' then raise exception 'Invalid network expiration';end if;
 select * into p from public.agent_network_peers where organization_id=NEW.organization_id and source_agent_id=NEW.sender_agent_id and target_agent_id=NEW.target_agent_id and status='active' for update;
 if not found then raise exception 'No active network trust edge exists';end if;
 if not(NEW.kind=any(p.allowed_message_types) or '*'=any(p.allowed_message_types)) then raise exception 'Message kind is outside trust edge';end if;
 if not(NEW.scope=any(p.allowed_scopes) or '*'=any(p.allowed_scopes)) then raise exception 'Message scope is outside trust edge';end if;
 if NEW.payload_size_bytes>p.max_payload_bytes then raise exception 'Message exceeds peer payload limit';end if;
 perform pg_advisory_xact_lock(hashtext(NEW.organization_id::text||':'||NEW.sender_agent_id||':'||NEW.target_agent_id));
 select count(*) into sent_count from public.agent_network_messages where organization_id=NEW.organization_id and sender_agent_id=NEW.sender_agent_id and target_agent_id=NEW.target_agent_id and created_at>=NEW.created_at-interval '1 minute';
 if sent_count>=p.rate_limit_per_minute then raise exception 'Agent network rate limit reached';end if;
 select * into k from public.agent_identity_keys where organization_id=NEW.organization_id and agent_id=NEW.sender_agent_id and key_version=NEW.signer_key_version and fingerprint=NEW.signer_fingerprint and status='active';
 if not found then raise exception 'Active signer identity key is not registered';end if;
 if NEW.kind='delegation' and not(/^agent\.delegation(?:\.|$)/=~NEW.scope) then raise exception 'Delegation scope is not authorized';end if;
 if NEW.kind='response' then
  if NEW.reply_to_message_id is null then raise exception 'Response must reference a prior message';end if;
  if not exists(select 1 from public.agent_network_messages prior where prior.organization_id=NEW.organization_id and prior.message_id=NEW.reply_to_message_id and prior.sender_agent_id=NEW.target_agent_id and prior.target_agent_id=NEW.sender_agent_id and prior.kind in('request','delegation')) then raise exception 'Response does not reference a matching request';end if;
 elsif NEW.reply_to_message_id is not null and not exists(select 1 from public.agent_network_messages prior where prior.organization_id=NEW.organization_id and prior.message_id=NEW.reply_to_message_id) then raise exception 'Reply target not found';end if;
 return NEW;
end; $$;
drop trigger if exists agent_network_message_admission_trigger on public.agent_network_messages;
create trigger agent_network_message_admission_trigger before insert on public.agent_network_messages for each row execute function public.agent_network_message_admission();

create or replace function public.agent_network_message_immutable() returns trigger language plpgsql security invoker as $$
begin
 if NEW.organization_id is distinct from OLD.organization_id or NEW.message_id is distinct from OLD.message_id or NEW.nonce is distinct from OLD.nonce or NEW.sender_agent_id is distinct from OLD.sender_agent_id or NEW.target_agent_id is distinct from OLD.target_agent_id or NEW.conversation_id is distinct from OLD.conversation_id or NEW.correlation_id is distinct from OLD.correlation_id or NEW.reply_to_message_id is distinct from OLD.reply_to_message_id or NEW.kind is distinct from OLD.kind or NEW.scope is distinct from OLD.scope or NEW.subject is distinct from OLD.subject or NEW.payload_ciphertext is distinct from OLD.payload_ciphertext or NEW.payload_iv is distinct from OLD.payload_iv or NEW.payload_auth_tag is distinct from OLD.payload_auth_tag or NEW.payload_key_version is distinct from OLD.payload_key_version or NEW.payload_hash is distinct from OLD.payload_hash or NEW.payload_size_bytes is distinct from OLD.payload_size_bytes or NEW.signature is distinct from OLD.signature or NEW.signer_key_version is distinct from OLD.signer_key_version or NEW.signer_fingerprint is distinct from OLD.signer_fingerprint or NEW.created_at is distinct from OLD.created_at then raise exception 'Signed network message is immutable';end if;
 if OLD.status='queued' and NEW.status not in('delivered','expired','rejected') then raise exception 'Invalid network status transition';end if;
 if OLD.status='delivered' and NEW.status not in('acknowledged','failed','expired') then raise exception 'Invalid network status transition';end if;
 if OLD.status in('acknowledged','failed','expired','rejected') and NEW.status is distinct from OLD.status then raise exception 'Terminal network message is immutable';end if;
 return NEW;
end; $$;
drop trigger if exists agent_network_message_immutable_trigger on public.agent_network_messages;
create trigger agent_network_message_immutable_trigger before update on public.agent_network_messages for each row execute function public.agent_network_message_immutable();

create or replace function public.agent_network_event_immutable() returns trigger language plpgsql security invoker as $$
begin raise exception 'Network event is append-only';end;$$;
drop trigger if exists agent_network_event_immutable_trigger on public.agent_network_events;
create trigger agent_network_event_immutable_trigger before update or delete on public.agent_network_events for each row execute function public.agent_network_event_immutable();

create or replace function public.record_agent_network_event() returns trigger language plpgsql security invoker as $$
begin
 if TG_OP='INSERT' then insert into public.agent_network_events(organization_id,message_id,event_type,actor_agent_id,status,metadata) values(NEW.organization_id,NEW.id,'message.queued',NEW.sender_agent_id,NEW.status,jsonb_build_object('messageId',NEW.message_id,'scope',NEW.scope,'kind',NEW.kind));
 elsif OLD.status is distinct from NEW.status then insert into public.agent_network_events(organization_id,message_id,event_type,actor_agent_id,status,metadata) values(NEW.organization_id,NEW.id,'status.'||NEW.status,NEW.last_actor_agent_id,NEW.status,jsonb_build_object('messageId',NEW.message_id,'attemptCount',NEW.attempt_count,'lastError',NEW.last_error));
 end if;return NEW;
end;$$;
drop trigger if exists agent_network_message_event_trigger on public.agent_network_messages;
create trigger agent_network_message_event_trigger after insert or update of status on public.agent_network_messages for each row execute function public.record_agent_network_event();

create or replace function public.claim_agent_network_messages(p_organization_id uuid,p_agent_id text,p_limit integer default 20,p_now timestamptz default now())
returns setof public.agent_network_messages language plpgsql security invoker as $$
begin
 if p_limit<1 or p_limit>50 then raise exception 'Invalid network claim limit';end if;
 perform pg_advisory_xact_lock(hashtext(p_organization_id::text||':'||p_agent_id));
 update public.agent_network_messages set status='expired',last_error='Message TTL expired',last_actor_agent_id=null where organization_id=p_organization_id and target_agent_id=p_agent_id and status in('queued','delivered') and expires_at<=p_now;
 return query with picked as(select id from public.agent_network_messages where organization_id=p_organization_id and target_agent_id=p_agent_id and status='queued' and available_at<=p_now and expires_at>p_now order by priority desc,created_at asc for update skip locked limit p_limit)
 update public.agent_network_messages m set status='delivered',attempt_count=m.attempt_count+1,delivered_at=coalesce(m.delivered_at,p_now),last_actor_agent_id=p_agent_id where m.id in(select id from picked) returning m.*;
end; $$;
revoke execute on function public.claim_agent_network_messages(uuid,text,integer,timestamptz) from public,anon,authenticated;grant execute on function public.claim_agent_network_messages(uuid,text,integer,timestamptz) to service_role;

create or replace function public.ack_agent_network_message(p_organization_id uuid,p_agent_id text,p_message_id text,p_success boolean,p_error text default null,p_now timestamptz default now())
returns setof public.agent_network_messages language plpgsql security invoker as $$
begin
 return query update public.agent_network_messages set status=case when p_success then 'acknowledged' else 'failed' end,acked_at=p_now,last_error=case when p_success then null else left(coalesce(p_error,'Recipient reported failure'),500) end,last_actor_agent_id=p_agent_id
 where organization_id=p_organization_id and message_id=p_message_id and target_agent_id=p_agent_id and status='delivered' and expires_at>p_now returning *;
 if not found then raise exception 'Message is not deliverable to this agent';end if;
end; $$;
revoke execute on function public.ack_agent_network_message(uuid,text,text,boolean,text,timestamptz) from public,anon,authenticated;grant execute on function public.ack_agent_network_message(uuid,text,text,boolean,text,timestamptz) to service_role;
revoke execute on function public.sync_agent_identity_key() from public,anon,authenticated;
revoke execute on function public.agent_network_peer_admission() from public,anon,authenticated;
revoke execute on function public.agent_network_message_admission() from public,anon,authenticated;
revoke execute on function public.agent_network_message_immutable() from public,anon,authenticated;
revoke execute on function public.agent_network_event_immutable() from public,anon,authenticated;
revoke execute on function public.record_agent_network_event() from public,anon,authenticated;
comment on table public.agent_network_peers is 'Explicit same-org trust edges controlling agent-to-agent message kinds, scopes, payload and rate.';
comment on table public.agent_network_messages is 'Signed agent messages with encrypted payloads, bounded TTL, replay-safe nonce and durable delivery state.';
comment on table public.agent_network_events is 'Append-only V6 agent network delivery history.';
