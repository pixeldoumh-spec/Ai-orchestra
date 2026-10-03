# Agent Orchestrator V2

A provider-neutral control plane for reliable autonomous AI workflows.

## What V2 actually adds

- Supabase/Postgres durable state
- Supabase SSR authentication foundation
- Organization tenancy and membership model
- RLS on every exposed public table
- Idempotent task creation
- Durable queue state with leases
- Checkpoints and append-only task events
- Dependency-aware workflow execution
- Retry with bounded exponential backoff
- Tool gateway with explicit permissions
- High/critical-risk approval boundary
- Server-side model adapter boundary
- Optional OpenAI Responses API adapter
- Usage/cost accounting hooks
- Task artifacts
- Internal worker endpoint for cron/worker infrastructure
- Health endpoint

## Runtime model

```text
User intent
  -> authenticated API
  -> durable task row
  -> validated workflow plan
  -> leased worker
  -> ready steps
  -> agent + policy gateway + model adapter
  -> checkpoint/event
  -> verifier
  -> verified outcome
```

## Run locally

1. Create a Supabase project and apply `supabase/migrations/20261003_agent_orchestrator_v2.sql`.
2. Copy `.env.example` to `.env.local` and fill in the browser-safe URL/publishable key plus the server-only Supabase secret key (`sb_secret_*`) and worker secret.
3. Use Node.js 22+.
4. Install dependencies with `npm install`.
5. Run `npm run typecheck` and `npm run build`.
6. Start with `AI_MODEL_PROVIDER=mock` to validate orchestration without a model key. Switch to `openai` only after setting `OPENAI_API_KEY`.

## Worker deployment

The durable queue is intentionally separated from the web request. A trusted scheduler/worker should POST to `/api/internal/worker` with `x-worker-secret`. The endpoint is server-only and does not expose provider credentials.

For a small deployment, a Render cron job can invoke the worker endpoint periodically. For a larger deployment, replace the HTTP poller with a queue service while keeping the database state machine and worker contract unchanged.

## Security model

Browser clients have read-only Data API access to orchestration tables. Task/step/approval state changes happen through authenticated server routes or the trusted worker, which keeps the state machine authoritative.

- No Supabase secret key in browser code; V2 uses the current `sb_secret_*` server key.
- Never use editable user metadata as an authorization source.
- All tenant tables have RLS.
- Tool calls require both an agent-declared tool and an explicit permission.
- High/critical-risk tools are approval-gated.
- Idempotency prevents duplicate task creation.
- Lease ownership limits concurrent workers.
- Task events provide an audit trail.
- Model/provider secrets live only on the server.

## Version history

V1 was the original in-memory orchestration proof: an agent registry, sequential workflow, adapter boundary, permission metadata, verification step and execution records. V2 is the canonical continuation and replaces V1 storage/runtime assumptions with durable multi-tenant state, policy enforcement, leases, retries, checkpoints, approvals and server-side model adapters. The repository history keeps V1 separately on the `v1-baseline` branch.

## Current V2 boundary

This version intentionally does **not** pretend to provide unrestricted autonomous access to arbitrary APIs. The `external.action` tool is registered as a high-risk placeholder and cannot silently execute anything. The next layer should add signed connectors, secret-scoped tool credentials, stronger policy evaluation, streaming events and multi-tenant billing.
