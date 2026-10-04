# Architecture · V6.2

## V5 enterprise layer

Browser -> Auth session -> tenant resolution -> fine-grained RBAC -> database admission controls -> model planner -> leased worker -> grounded retrieval/tools -> scoped connector execution -> evidence ledger -> independent verification -> usage metering + audit -> durable result.

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
## V6.2 grounding plane

Research-capable agents can invoke hosted web search and tenant file search through the model Responses API. Web-search source lists and file-search retrieval results are captured as bounded citation metadata and converted into immutable evidence packets. Evidence packets carry source identity, a decision-relevant claim, a bounded excerpt, optional retrieval confidence, content hash and capture time. This preserves traceability without storing hidden reasoning or raw credentials.

### Document ingestion

A workspace upload is authenticated against its organization, hashed for deduplication, stored in a private Supabase Storage bucket, uploaded to the provider file store and attached to the organization's retrieval index. Document state is durable (stored, indexing, ready, failed, deleted) and can be refreshed through the document status route. Provider file identifiers are metadata, not credentials.

### Connector execution

Read-only connector retrieval runs through an allow-listed HTTPS connector route, credential binding and circuit-breaker checks. High-risk external actions are represented as signed, encrypted connector intents. Approval is a separate state transition; the executor atomically claims the approved intent, revalidates the active agent, organization policy, connector binding and credential, executes the same stored method/path with a request idempotency key, records evidence and closes the intent. A crash before closure is therefore distinguishable from an executed request, and connector APIs should use the idempotency key to make retries safe.

### Trust boundary

Web pages, retrieved files, connector responses and agent messages are treated as untrusted data. They can inform a task but cannot redefine tool permissions, approval policy, or the system instruction.
## V6.3 specialized agent plane

The runtime now treats Research, Analysis, Writer and Verifier as explicit execution roles. The planner receives each registered agent's specialization and the plan is rejected unless the current executable DAG covers all four roles plus a verification step. This prevents a generic model response from masquerading as a multi-agent workflow.

Research is evidence-first and reports unknowns/conflicts. Analysis reasons over supplied evidence and separates observation from inference. Writer produces the user-facing deliverable without inventing new facts. Verifier independently audits terminal work and must return a strict passing verification object before finalization.

Step failures use bounded exponential backoff with jitter and durable retry events. Exhausted retries enter the existing bounded replanning path; verifier rejection follows the same failure/retry/replan semantics. No hidden chain-of-thought is persisted.
