# V4 API Contract

## Authentication

Browser requests use Supabase SSR cookies. Tenant-returning routes authenticate the caller and resolve an organization membership before reading or mutating workflow state.

## Endpoints

`GET /api/health`
Returns service health/version without authentication.

`POST /api/organizations`
Creates a workspace for the authenticated user and seeds the default agent registry.

`GET /api/agents?organizationId=<uuid>`
Returns the caller's organization and registered agents.

`POST /api/tasks`
Headers: `Idempotency-Key: <unique-client-key>`
Body: `{ "goal": string, "organizationId?": string, "maxCostCents?": number }`
The route builds a V4 plan through the planner, validates it, then persists the task and plan revision before execution.

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

## Task state machine

```text
queued -> running -> verified
            |
            +-> awaiting_approval -> queued
            |
            +-> failed

queued/running -> cancelled
```

Recovery replanning creates a new plan revision while preserving the historical steps of prior revisions. A retry keeps a step in `queued` and uses `run_after` for bounded exponential backoff; the worker also copies the earliest retry wake-up onto the task's `run_after` field.

## V4 invariants

1. A plan must be an acyclic DAG with 2–16 steps.
2. Every referenced agent must be available and non-offline.
3. Every terminal work step must be covered by a verification step.
4. Independent ready steps may execute concurrently, subject to the task budget ceiling.
5. Cumulative step attempt spend is reconciled to task spend after each execution frontier.
6. A task can only become `verified` after a verified step in the current plan revision passes the verification contract.
7. High/critical-risk tools require approval; the exact approval ID must be resolved.
8. Duplicate `(organization_id, idempotency_key)` returns the existing task.
9. Tenant authorization remains explicit at the application boundary and RLS-protected in Supabase.

## Connector endpoints

`GET /api/connectors?organizationId=<uuid>` returns connector metadata and agent bindings. Secret material is excluded.

`POST /api/connectors` creates a connector. Owner/admin only. `baseUrl`, when provided, must use HTTPS.

`PATCH /api/connectors/<connectorId>` changes connector status. Owner/admin only.

`GET /api/connectors/<connectorId>/credentials` returns non-secret credential metadata.

`POST /api/connectors/<connectorId>/credentials` stores an encrypted credential. Owner/admin only. The plaintext secret is never returned.

`GET /api/connectors/<connectorId>/bindings` returns agent bindings for that connector.

`POST /api/connectors/<connectorId>/bindings` binds an agent with explicit tool allowlists, scopes and optional credential. Owner/admin only.

`POST /api/connectors/<connectorId>/health` with `{"action":"reset_circuit"}` resets a connector circuit. Owner/admin only.

## V4 invariants

10. Connector routes never cross organization boundaries.
11. Credential plaintext and agent private keys are server-only and encrypted at rest.
12. A connector credential must match the connector auth scheme and be active, unexpired and scoped for the requested tool.
13. Prepared connector requests expire and use unique nonces; provenance stores hashes rather than raw payload copies.
14. Circuit health updates are atomic; fallback traversal is bounded and cycle-safe.
