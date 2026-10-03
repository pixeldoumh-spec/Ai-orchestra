# Architecture

## V5 enterprise layer

Browser -> Auth session -> tenant resolution -> fine-grained RBAC -> database admission controls -> V4 planner -> leased worker -> scoped tools/connectors -> verification -> usage metering + audit -> durable result.

### Enterprise admission

Per-organization PostgreSQL advisory transaction locking serializes admission decisions. A task insert reserves its maximum declared cost in the current UTC month. Terminal task states release that reservation using the task's original reservation month. Task cost and reservation period are immutable after admission.

The running-concurrency trigger performs the same organization lock before a queued task can become running, preventing parallel workers from bypassing the organization concurrency ceiling.

Agent and member insertions are also admission-gated against organization entitlements.

### Governance

RBAC is centralized in an application permission matrix and enforced by route checks. Database RLS remains the browser tenant boundary.

### Usage

Actual model/tool usage is recorded as integer cents in an append-oriented ledger. A service-role-only RPC updates the monthly aggregate under a per-organization transaction lock. Raw prompt and connector payload data is excluded.

### Regions and SLA

Every task carries an execution region selected from the organization's allowlist. Data residency and SLA targets are declarative governance metadata; cross-region worker deployment and failover remain infrastructure concerns.