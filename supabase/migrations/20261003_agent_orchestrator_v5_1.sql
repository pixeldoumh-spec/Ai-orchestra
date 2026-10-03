-- V5.1 integrity patch: service-role usage RPC, append-only metering, and deterministic reservation accounting.
create or replace function public.enterprise_record_usage(p_organization_id uuid,p_task_id text,p_step_id text,p_kind text,p_quantity bigint,p_unit_cost_cents integer,p_cost_cents bigint,p_region text,p_idempotency_key text)
returns table(monthly_spend_cents bigint,monthly_reserved_cents bigint,budget_exceeded boolean) language plpgsql security invoker as $$
declare period date:=date_trunc('month',now())::date;s bigint;r bigint;lim bigint;
begin
 if p_quantity<=0 or p_unit_cost_cents<0 or p_cost_cents<0 then raise exception 'Invalid usage values'; end if;
 if char_length(p_idempotency_key)<8 or char_length(p_idempotency_key)>160 then raise exception 'Invalid usage idempotency key'; end if;
 perform pg_advisory_xact_lock(hashtext(p_organization_id::text));
 insert into public.enterprise_usage_monthly(organization_id,period_start) values(p_organization_id,period) on conflict(organization_id,period_start) do nothing;
 select spend_cents,reserved_cents into s,r from public.enterprise_usage_monthly where organization_id=p_organization_id and period_start=period for update;
 select monthly_spend_limit_cents into lim from public.organization_entitlements where organization_id=p_organization_id;
 if lim is null then raise exception 'Enterprise entitlements not initialized'; end if;
 insert into public.enterprise_usage_ledger(organization_id,task_id,step_id,kind,quantity,unit_cost_cents,cost_cents,region,idempotency_key) values(p_organization_id,p_task_id,p_step_id,p_kind,p_quantity,p_unit_cost_cents,p_cost_cents,left(p_region,64),p_idempotency_key);
 s:=s+p_cost_cents;
 update public.enterprise_usage_monthly set spend_cents=s,updated_at=now() where organization_id=p_organization_id and period_start=period;
 return query select s,r,(s>lim);
exception when unique_violation then
 select spend_cents,reserved_cents into s,r from public.enterprise_usage_monthly where organization_id=p_organization_id and period_start=period;
 return query select s,r,(s>coalesce((select monthly_spend_limit_cents from public.organization_entitlements where organization_id=p_organization_id),0));
end; $$;
revoke execute on function public.enterprise_record_usage(uuid,text,text,text,bigint,integer,bigint,text,text) from public,anon,authenticated;
grant execute on function public.enterprise_record_usage(uuid,text,text,text,bigint,integer,bigint,text,text) to service_role;