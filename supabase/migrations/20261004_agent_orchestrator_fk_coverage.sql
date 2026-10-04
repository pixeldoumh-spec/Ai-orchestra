-- Cover the remaining foreign keys reported by Supabase's performance advisor.
create index if not exists idx_acb_connector_fk
  on public.agent_connector_bindings(organization_id, connector_id);
create index if not exists idx_acb_credential_fk
  on public.agent_connector_bindings(credential_id);

create index if not exists idx_approvals_connector_request_fk
  on public.approvals(connector_request_id);
create index if not exists idx_approvals_resolved_by_fk
  on public.approvals(resolved_by);
create index if not exists idx_approvals_step_fk
  on public.approvals(step_id);
create index if not exists idx_approvals_task_org_fk
  on public.approvals(task_id, organization_id);

create index if not exists idx_connector_credentials_created_by_fk
  on public.connector_credentials(created_by);

create index if not exists idx_connector_requests_credential_fk
  on public.connector_requests(credential_id);
create index if not exists idx_connector_requests_org_fk
  on public.connector_requests(organization_id);
create index if not exists idx_connector_requests_step_fk
  on public.connector_requests(step_id);
create index if not exists idx_connector_requests_task_org_fk
  on public.connector_requests(task_id, organization_id);

create index if not exists idx_connectors_created_by_fk
  on public.connectors(created_by);
create index if not exists idx_connectors_fallback_fk
  on public.connectors(fallback_connector_id);
create index if not exists idx_connectors_fallback_org_fk
  on public.connectors(organization_id, fallback_connector_id);

create index if not exists idx_enterprise_invitations_invited_by_fk
  on public.enterprise_invitations(invited_by);

create index if not exists idx_enterprise_teams_created_by_fk
  on public.enterprise_teams(created_by);

create index if not exists idx_enterprise_usage_ledger_step_fk
  on public.enterprise_usage_ledger(step_id);
create index if not exists idx_enterprise_usage_ledger_task_fk
  on public.enterprise_usage_ledger(task_id);

create index if not exists idx_organizations_created_by_fk
  on public.organizations(created_by);

create index if not exists idx_task_artifacts_task_fk
  on public.task_artifacts(task_id);
create index if not exists idx_task_events_task_org_fk
  on public.task_events(task_id, organization_id);

create index if not exists idx_tasks_created_by_fk
  on public.tasks(created_by);

create index if not exists idx_tool_invocations_connector_request_fk
  on public.tool_invocations(connector_request_id);
create index if not exists idx_tool_invocations_org_fk
  on public.tool_invocations(organization_id);
create index if not exists idx_tool_invocations_step_fk
  on public.tool_invocations(step_id);
