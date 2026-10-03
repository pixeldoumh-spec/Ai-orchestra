# Agent Orchestrator V2

A provider-neutral control plane for reliable autonomous AI workflows.

## V2
- Durable Supabase/Postgres task state
- Organization tenancy and RLS
- Idempotency, leases, checkpoints and retries
- Dependency-aware workflows
- Policy-gated tools and approval boundaries
- Provider-neutral model adapters
- Usage/cost accounting hooks
- Internal worker endpoint

## Runtime
```text
User intent -> authenticated API -> durable task -> workflow -> leased worker -> agents/tools -> verification -> outcome
```

## Security boundary
Browser clients are read-only against orchestration tables. State transitions happen through authenticated server routes or the trusted worker. Provider and Supabase secret keys remain server-side. High/critical-risk tools require approval. V2 does not expose unrestricted arbitrary external actions.

## Local setup
1. Create a dedicated Supabase project and apply the migration in `supabase/migrations/`.
2. Copy `.env.example` to `.env.local`.
3. Use Node.js 22+ and run `npm install`.
4. Run `npm run typecheck` and `npm run test:core`.
5. Start with `AI_MODEL_PROVIDER=mock`; configure an actual provider only when ready.

Deployment is intentionally not configured yet.
