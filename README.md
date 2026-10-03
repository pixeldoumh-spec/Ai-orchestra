# Agent Orchestrator V4

A provider-neutral AI control plane for planning, executing, verifying and recovering multi-agent workflows.

## What V4 adds

- LLM-driven workflow planner with strict Zod validation
- DAG cycle/dependency validation before persistence
- Intentional parallel execution of independent ready steps
- Budget-aware parallel batching using per-agent ceilings
- Structured agent tool requests through the existing policy gateway
- First-class verification steps with machine-checkable pass/fail envelopes
- Cumulative attempt spend accounting
- Retry wake-up scheduling so backoff does not strand tasks
- Bounded automatic recovery replanning with plan revisions
- Plan provenance: planner model, revision and persisted plan JSON
- Approval identifiers tied to the exact pending approval
- Per-agent Ed25519 identity with encrypted private-key storage
- Encrypted, versioned connector credential vault with explicit scope
- Agent-to-connector bindings with least-privilege tool allowlists
- Signed, expiring connector requests with nonce replay protection
- Connector health history, atomic circuit breaking and bounded fallbacks
- Tool/request provenance stored as hashes instead of raw sensitive payloads
- Append-only task-event enforcement at the database layer

## Runtime model

```text
User intent
  -> authenticated API
  -> V3 planner
  -> validated DAG
  -> durable task + plan revision
  -> leased worker
  -> ready frontier
       |\
       | +--> agent step A --+
       +----> agent step B --+--> downstream step(s)
                              -> verifier
                              -> verified outcome

Failure after retries -> bounded replan -> new plan revision
High/critical tool      -> approval gate -> resume/reject
```

## Planner behavior

When `AI_MODEL_PROVIDER=mock`, V3 uses a deterministic fallback that intentionally contains two independent research branches so the execution engine can be validated without a model credential. When `AI_MODEL_PROVIDER=openai`, the server-side Responses adapter supplies the planning request; the returned plan must pass schema, agent-availability, dependency, cycle and verification-coverage checks before it can be stored.

A planner is never trusted merely because it returned JSON. The plan validator is the authority for graph shape and safety constraints.

## Execution behavior

The worker calculates the ready frontier from persisted step state and executes the selected frontier concurrently with `Promise.all`. It limits the batch by configured agent budgets and the task's remaining cost ceiling. Step spend is accumulated across attempts, then reconciled to the task after every batch.

Retries use bounded exponential backoff. The next wake-up time is copied onto the task queue row so an internal scheduler can pick the task up again. When a step exhausts its retries, V3 can request a replacement DAG up to `TASK_MAX_REPLANS` times while preserving the prior plan revision for auditability.

## Verification

Verification is not a non-empty-string check. Verification agents are required to return a JSON envelope containing `passed`, `confidence`, `findings`, and `evidence`. A task can only enter `verified` after a verification step in the current plan revision passes.

## Security boundaries

Browser clients use the Supabase publishable key. Server routes and workers use the server-only Supabase secret key. Tenant tables remain RLS-protected and browser access is read-only. Tool use requires an agent-declared tool plus an explicit permission. High/critical-risk tools stop for human approval. Provider credentials never enter the browser bundle.

`external.action` remains a deliberately non-executing high-risk placeholder until connector identity, secret scoping, provenance and rollback semantics are built in a later infrastructure layer.

## Run locally

1. Create a dedicated Supabase project for this application.
2. Apply `supabase/migrations/20261003_agent_orchestrator_v2.sql` followed by `supabase/migrations/20261003_agent_orchestrator_v3.sql` followed by `20261003_agent_orchestrator_v4.sql`.
3. Copy `.env.example` to `.env.local` and fill the server/browser Supabase variables plus worker secret.
4. Use Node.js 22+.
5. Run `npm install`.
6. Validate with `npm run typecheck`, `npm run test:core` and `npm run build`.
7. Start with `AI_MODEL_PROVIDER=mock`; configure the OpenAI adapter only when a provider credential is intentionally added.

## Worker deployment

A trusted scheduler may POST to `/api/internal/worker` with `x-worker-secret`. The web-facing `/api/tasks/<id>/start` route remains a control-plane kick for development/manual operation; production scheduling should use the internal worker endpoint and eventually a durable queue service.