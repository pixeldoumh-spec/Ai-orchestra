# V2 Architecture Notes

## Design decisions

### 1. Database is the source of truth
The workflow state machine lives in Postgres. The worker is disposable. A worker crash should not erase the task.

### 2. Queue semantics without pretending Postgres is a queue vendor
Tasks are persisted with `status`, `run_after`, `lease_owner`, and `lease_until`. Workers claim work with a conditional update and can safely retry after an expired lease. A dedicated queue can be introduced later without changing the task contract.

### 3. RLS is tenant isolation; service role is worker infrastructure
Browser requests use the publishable Supabase key and SSR auth. Worker processes use the server-side Supabase secret key only on the server. Authorization decisions must still be explicit at the application boundary.

### 4. Agents are not tools
An agent is a reasoning identity. A tool is an executable capability. The gateway mediates the latter.

### 5. Verification is a state transition
A task only becomes `verified` after the verifier step succeeds. A model output that says “done” is not considered proof by itself.

### 6. Approval is part of the workflow graph
A risky action pauses at `awaiting_approval`; approval resolution puts the step back into `queued` or permanently fails it.

### 7. Model providers are adapters
The orchestration engine depends on `ModelAdapter`, not OpenAI. Current V2 ships a mock adapter and an OpenAI Responses adapter. This keeps provider lock-in out of task semantics.

## Future V3 work

- Dynamic LLM planner producing a validated DAG
- True parallel step execution
- Signed tool connectors and per-connector secret scopes
- Prompt/response tracing with redaction
- Streaming task events over Realtime
- Token-level budgets and provider routing
- Model fallback/circuit breakers
- Organization roles with richer policies
- Billing and usage ledger
- Evaluation harness for agent quality
