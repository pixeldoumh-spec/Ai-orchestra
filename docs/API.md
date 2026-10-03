# API

## Existing orchestration

POST /api/organizations
GET /api/agents
POST /api/tasks
GET /api/tasks/:id
POST /api/tasks/:id/start
POST /api/tasks/:id/approve
GET /api/connectors and connector administration routes

## Enterprise

GET /api/enterprise — organization entitlements, policy, teams, members, SLA definitions, monthly usage and recent audit preview.

PATCH /api/enterprise — owner/admin updates entitlements or policy.

GET/POST /api/enterprise/teams — list/create teams.

POST /api/enterprise/teams/:id/members — add or update an existing organization member in a team.

PATCH /api/enterprise/members/:userId — change a non-owner member RBAC role.

POST /api/enterprise/invitations — create a seven-day invitation; raw token is returned once and is not emailed.

POST /api/enterprise/invitations/accept — redeem a matching invitation from a signed-in account.

GET /api/enterprise/usage — usage aggregates and recent metering ledger for owner/admin/billing roles.

GET /api/enterprise/audit — audit entries for owner/admin/auditor roles.

## Database enforcement

Task admission is enforced in Postgres before insertion. It checks maximum task cost, monthly task count, monthly spend plus reservations and allowed execution region. A separate status trigger enforces organization concurrency when a task transitions to running. Agent and member ceilings are also enforced by database triggers.

No endpoint returns connector secrets, encrypted private-key material, invitation token hashes, raw prompts or raw connector payloads.