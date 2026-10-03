# V5 Architecture Notes

## 1. Planner is untrusted input, validator is authority

The planner can be an LLM. Its output is not trusted. A plan is accepted only after schema validation, agent allow-list validation, dependency validation, cycle detection and terminal verification coverage checks.

## 2. The ready frontier is the unit of parallelism

The worker repeatedly computes steps whose dependencies are verified and whose retry delay has elapsed. That frontier is executed with `Promise.all`. The batch is reduced when configured agent budgets would exceed the task's remaining ceiling. This gives real concurrency without allowing a single ready frontier to bypass cost controls.

## 3. Database remains the source of truth

Task state, plan revisions, steps, spend, events, approvals and network delegation contracts live in Postgres. A worker can disappear and another worker can recover leased work after expiry.

## 4. Replanning preserves history

When a step exhausts its retries, the planner can request a replacement DAG. New steps receive a new `plan_revision`; queued steps from the old revision are cancelled rather than overwritten. This retains the failure trail while allowing a different decomposition.

## 5. Verification is structured

Verification agents return a machine-readable contract with pass/fail, confidence, findings and evidence. Finalization uses only the current plan revision and only occurs when the verifier passes.

## 6. Tool use is model-directed but policy-controlled

An agent may return bounded tool requests. The gateway still decides whether the request is executable. The agent must declare the tool, possess its permission and satisfy the tool's risk policy. High/critical-risk tools stop for approval.

## 7. Spend is attempt-aware

Each step stores both last-attempt usage and cumulative usage. After each parallel frontier, task spend is recalculated from cumulative step totals. This avoids races where parallel steps could overwrite one another's spend update.

## 8. Retry scheduling is queue-aware

Step backoff is persisted on `run_after`. The worker also sets the task-level `run_after` to the earliest future ready time when a frontier is temporarily blocked. This prevents a task from remaining indefinitely in `running` with no scheduler wake-up signal.

## 9. V4 connector boundary

Connector identity, credentials and execution sit behind explicit server-side boundaries:

`agent → encrypted Ed25519 identity → scoped agent/connector binding → credential scope → circuit breaker/fallback → signed expiring request → approval → connector adapter`.

Credential plaintext is never stored. AES-256-GCM ciphertext carries an explicit key version, while browser roles cannot read credential or private-key rows. Tool allowlists and credential scopes are checked before a connector route is accepted.

Connector requests receive a unique request id, nonce, expiry, payload hash and agent signature. Provenance stores hashes rather than duplicating raw tool payloads. Connector outcome recording uses a row-locked Postgres function so failure counters and health events change atomically.

## 10. V5 agent network

Marketplace listings are metadata and never grant execution authority. A cross-organization delegation requires a different provider organization and provider-controlled authorization through an active share or provider acceptance. Direct-share delegation is supported even when the provider agent is not marketplace-listed.

Capability negotiation is fail-closed: the target agent must support every requested capability. A provider share can further narrow the negotiated set. Delegations persist the negotiated contract, contract hash, bounded budget, expiry and trust snapshot.

Remote execution is model-only. The executor loads the target agent definition and model selection, but never copies connector bindings, credentials, tool permissions or hidden task context across the organization boundary.

Provider acceptance may create a reusable share for future requests. Automatic acceptance is bounded by the stored capabilities, budget and expiry. Revocation prevents new work and causes accepted work to fail closed when execution revalidates the share.

## 11. Network trust is advisory, not authority

Reputation is a reliability signal derived from completed and failed delegations. It can be used as a minimum threshold during discovery/delegation, but it never replaces provider authorization, capability negotiation, budget checks, expiry validation or execution-time share revalidation.
