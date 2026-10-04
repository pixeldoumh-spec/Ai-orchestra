-- V6.5 patch: explicitly permit the server service role to call retrieval RPCs.
grant execute on function public.search_workspace_knowledge(uuid,uuid,vector,integer,boolean) to service_role;
grant execute on function public.search_workspace_memory(uuid,uuid,text,integer) to service_role;
