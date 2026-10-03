# Threat Model V3

## Assets
- Task goals, intermediate outputs and final verified results
- Organization membership and tenant boundaries
- Agent permissions and tool allow-lists
- Model/provider credentials
- Approval decisions
- Immutable task events and plan-revision history

## Threats and mitigations

### Malicious or malformed LLM plan
Mitigation: bounded Zod schema, agent allow-list, acyclic dependency validator, terminal verification coverage and a 16-step maximum before persistence.

### Cross-tenant data access
Mitigation: organization membership checks at the application boundary, organization-scoped queries and RLS on all exposed orchestration tables.

### Secret exfiltration
Mitigation: provider and Supabase secret credentials are server-only; no arbitrary tool execution; connector credentials are not part of the V3 browser contract.

### Duplicate task submission
Mitigation: organization-scoped idempotency key and durable task row.

### Worker race / duplicate execution
Mitigation: conditional task claim with lease ownership and expiry. A task has one live lease, while its ready frontier may execute in parallel inside that worker.

### Cost amplification
Mitigation: per-agent budgets, task budget ceiling, budget-aware frontier selection and cumulative attempt accounting.

### Retry storm
Mitigation: bounded exponential backoff, task-level wake-up propagation and `TASK_MAX_STEPS` / `TASK_MAX_REPLANS` caps.

### Verification bypass
Mitigation: finalization requires a passing verification step from the current plan revision; raw model text cannot set the task to verified.

### Approval confusion / wrong approval
Mitigation: V3 approval resolution requires the exact approval identifier and checks task + organization ownership. Expired pending approvals are rejected.

### Audit tampering
Mitigation: `task_events` is append-only at the database trigger layer.

### Prompt injection from retrieved/tool data
Mitigation: tool outputs are treated as untrusted data and cannot modify planner policy. A future connector layer should add provenance and content isolation.

## Remaining V4 boundary

V3 still uses a server-side model adapter and a small builtin tool registry. Signed connectors, per-connector secret scopes, provider circuit breakers, richer organization policy and external action rollback are intentionally deferred.