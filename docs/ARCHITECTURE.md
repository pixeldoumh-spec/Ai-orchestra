# Agent Orchestrator V1

## Goal
Build infrastructure for reliable autonomous AI workflows rather than a single chatbot.

## V1 boundaries
- Agent registry
- Structured task model
- Sequential orchestration runtime
- Adapter boundary for model/provider integration
- Permission metadata
- Verification step
- Execution records

## Next engineering steps
1. Replace in-memory state with Postgres/Supabase.
2. Add authenticated organizations and users.
3. Add a durable queue and idempotency keys.
4. Add a tool gateway enforcing capability + permission policies.
5. Add event-sourced execution logs and checkpoints.
6. Add approval gates for sensitive actions.
7. Add model adapters behind a common interface.
8. Add retry/fallback strategies with circuit breakers.
9. Add observability and cost accounting.
10. Add workflow DAGs and parallel execution.

## Security principles
- Never expose provider secrets to browser clients.
- Treat every tool invocation as a policy decision.
- Require explicit scopes for agents.
- Make actions auditable.
- Make workflows idempotent where possible.
- Default risky actions to human approval.
