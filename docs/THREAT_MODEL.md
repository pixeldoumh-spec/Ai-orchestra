# Threat Model V2

## Assets
- Task goals and outputs
- Organization membership
- Agent permissions
- Model/provider credentials
- Tool connector credentials
- Audit events

## Key threats

### Cross-tenant data access
Mitigation: RLS on all public tenant tables, organization membership predicates, and organization-scoped service operations.

### Secret exfiltration
Mitigation: server-only Supabase secret key and provider keys, no `NEXT_PUBLIC_` secret names, and no arbitrary tool execution in V2.

### Replay / duplicate execution
Mitigation: idempotency keys for task creation, task leases, checkpoints, and explicit state transitions.

### Tool abuse
Mitigation: tool registry, explicit agent tool allow-list, permission checks, risk classification, and approval gating.

### Prompt injection from tool data
Mitigation: treat tool outputs as untrusted data, never as policy instructions. A future signed connector layer should include provenance metadata and content isolation.

### Worker race
Mitigation: conditional task claim and lease expiry. Multiple workers may inspect the same queue, but only one should acquire a live lease.

### Stale authorization
Mitigation: do not use editable `user_metadata` for roles. Memberships are server-side database records protected by RLS.

## Explicit non-goals

V2 does not attempt to make arbitrary external actions autonomous. The external action surface remains high-risk and approval-gated. This is deliberate until connector identity, secret scoping, provenance, and rollback semantics are designed.
