# V5 API Contract

## Authentication

Browser requests use Supabase SSR cookies. Tenant-returning routes authenticate the caller and resolve an organization membership before reading or mutating workflow state.

## Core endpoints

`GET /api/health`
Returns service health/version without authentication.

`POST /api/organizations`
Creates a workspace for the authenticated user and seeds the default agent registry.

`GET /api/agents?organizationId=<uuid>`
Returns the caller's organization and registered agents.

`POST /api/tasks`
Headers: `Idempotency-Key: <unique-client-key>`
Body: `{ "goal": string, "organizationId?": string, "maxCostCents?": number }`
The route builds a V5 plan through the planner, validates it, then persists the task and plan revision before execution.

`GET /api/tasks/<taskId>`
Returns the task, current and historical plan steps, event trail, artifacts and approvals for the caller's organization.

`POST /api/tasks/<taskId>/start`
Authenticated control-plane kick. Claims the task and processes its current ready frontier. Production scheduling should prefer `/api/internal/worker`.

`POST /api/tasks/<taskId>/approve`
Body: `{ "approvalId": string, "decision": "approve" | "reject" }`
Resolves exactly the addressed pending approval. Expired approvals are rejected and recorded.

`POST /api/internal/worker`
Header: `x-worker-secret: <server-only-secret>`
Trusted scheduler endpoint. Claims and processes eligible tasks.

## Connector endpoints

`GET /api/connectors?organizationId=<uuid>` returns connector metadata and agent bindings. Secret material is excluded.

`POST /api/connectors` creates a connector. Owner/admin only. `baseUrl`, when provided, must use HTTPS.

`PATCH /api/connectors/<connectorId>` changes connector status. Owner/admin only.

`GET /api/connectors/<connectorId>/credentials` returns non-secret credential metadata.

`POST /api/connectors/<connectorId>/credentials` stores an encrypted credential. Owner/admin only. The plaintext secret is never returned.

`GET /api/connectors/<connectorId>/bindings` returns agent bindings for that connector.

`POST /api/connectors/<connectorId>/bindings` binds an agent with explicit tool allowlists, scopes and optional credential. Owner/admin only.

`POST /api/connectors/<connectorId>/health` with `{"action":"reset_circuit"}` resets a connector circuit. Owner/admin only.

## Network endpoints

`GET /api/network/agents?organizationId=<uuid>&q=<text>&capability=<capability>`
Returns public published listings plus agents explicitly shared with the caller's organization. Results contain metadata and reputation signals only; credentials and tools are never returned.

`POST /api/network/listings?organizationId=<uuid>`
Owner/admin only. Publishes an agent marketplace listing. The listing stores a capability snapshot and never stores credentials.

`GET /api/network/listings?organizationId=<uuid>`
Returns listings owned by the caller's organization.

`PATCH /api/network/listings/<listingId>?organizationId=<uuid>`
Owner/admin only. Updates listing metadata, visibility, publication state or delegation mode.

`POST /api/network/shares?organizationId=<provider-org-uuid>`
Owner/admin only. Creates or replaces a provider-controlled share for a consumer organization, with explicit capability allowlist, budget, expiry and optional auto-accept.

`GET /api/network/shares?organizationId=<uuid>`
Returns shares involving the caller's organization.

`PATCH /api/network/shares/<shareId>?organizationId=<provider-org-uuid>`
Owner/admin only. Revokes or changes a provider-controlled share's budget, expiry or acceptance mode.

`POST /api/network/delegations?organizationId=<consumer-org-uuid>`
Creates a durable cross-organization delegation. Supply either `listingId` or `shareId`; direct-share delegation works even when the provider agent is not marketplace-listed. The request includes source agent, objective, requested capabilities, bounded budget, minimum trust threshold, expiry and idempotency key.

`GET /api/network/delegations/<delegationId>?organizationId=<consumer-org-uuid>`
Returns a delegation belonging to the caller's source organization.

`POST /api/network/delegations/<delegationId>/resolve`
Provider owner/admin only. Body: `{ "decision": "accept" | "reject", "allowedCapabilities?": string[], "maxCostCents?": number, "autoAccept?": boolean }`.

`POST /api/network/delegations/<delegationId>/execute?organizationId=<consumer-org-uuid>`
Consumer-side execution kick for an accepted delegation. The executor runs the provider agent in isolated model-only mode; it does not pass source credentials, connectors, tools or hidden context.

## Task state machine

```text
queued -> running -> verified
            |
            +-> awaiting_approval -> queued
            |
            +-> failed

queued/running -> cancelled
```

Network delegation state is separate:

```text
requested -> accepted -> running -> completed
     |          |            |
     +-> rejected              +-> failed
     |
     +-> expired / cancelled
```

## V5 invariants

1. Plans are validated as acyclic DAGs before persistence.
2. Every referenced local agent must be available and non-offline.
3. Every terminal work step must be covered by a verification step.
4. Independent ready steps may execute concurrently, subject to the task budget ceiling.
5. Cumulative step attempt spend is reconciled to task spend after each execution frontier.
6. A task can only become `verified` after a verified step in the current plan revision passes the verification contract.
7. High/critical-risk tools require approval; the exact approval ID must be resolved.
8. Duplicate `(organization_id, idempotency_key)` returns the existing task or network delegation.
9. Public discovery is metadata-only; credentials and tool bindings are never exposed through network discovery.
10. Cross-organization delegation requires a different provider organization and provider-controlled access through a published public listing plus an active share or an explicit direct share.
11. Requested capabilities can only be negotiated downward to the intersection of provider capabilities and the share allowlist.
12. Network budgets are bounded by the provider share and the delegation contract.
13. Provider acceptance is required unless the provider explicitly enables `autoAccept` on the active share.
14. Remote execution is model-only. Source organization credentials, connectors, tools and hidden context never cross the trust boundary.
15. Delegation idempotency and bounded leases prevent duplicate execution claims.
16. Trust scores are reliability signals with a bounded prior and a durable reputation event for each completed/failed delegation.
17. Network tables have RLS enabled and browser roles have no direct table privileges; network mutations occur through authenticated server routes.
18. Reputation mutation is a server-only `SECURITY INVOKER` database function.
