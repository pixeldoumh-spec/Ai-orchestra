# V2 API Contract

## Authentication

Browser requests use Supabase SSR cookies. Every application route that returns tenant data first resolves the signed-in user and then resolves an organization membership.

## Endpoints

`GET /api/health`
Returns service health/version without requiring authentication.

`POST /api/organizations`
Creates a workspace for the authenticated user and seeds the default agent registry.

`GET /api/agents?organizationId=<uuid>`
Returns the caller's organization and registered agents.

`POST /api/tasks`
Headers: `Idempotency-Key: <unique-client-key>`
Body: `{ "goal": string, "organizationId?": string, "maxCostCents?": number }`
The route persists the task and validated workflow before execution.

`GET /api/tasks/<taskId>`
Returns the task, steps, event trail and artifacts for the caller's organization.

`POST /api/tasks/<taskId>/start`
Authenticated development/control-plane kick endpoint. Claims the task and processes available work. Production schedulers should prefer the internal worker.

`POST /api/tasks/<taskId>/approve`
Body: `{ "decision": "approve" | "reject" }`
Resolves a pending human approval and requeues or fails the affected step.

`POST /api/internal/worker`
Header: `x-worker-secret: <server-only-secret>`
Trusted scheduler endpoint. Claims and processes eligible queued/expired-lease tasks.

## State machine

```text
queued -> running -> verified
            |
            +-> awaiting_approval -> queued
            |
            +-> failed

queued/running -> cancelled
```

A step follows the same pattern. Retries leave the step in `queued` with `run_after` set using bounded exponential backoff. A lease expiry allows recovery by another worker.

## Invariants

1. Browser clients cannot directly mutate orchestration state.
2. A task cannot become `verified` until the verifier step succeeds.
3. A high/critical-risk tool cannot execute without approval.
4. A duplicate `(organization_id, idempotency_key)` returns the original task instead of creating another.
5. Worker/provider secrets remain server-side.
