# Agent Orchestrator V5

A provider-neutral AI control plane for planning, executing, verifying, protecting and governing multi-agent workflows.

## V5 enterprise control plane

V5 adds fine-grained organization RBAC, teams, one-time invitations, plan entitlements, database-enforced task admission, monthly task and spend ceilings, reservations, usage metering, audit trails, regional execution and data-residency policy, and declarative SLA targets.

V4 identity, encrypted credential vault, scoped connector bindings, signed requests, provenance and circuit breaking remain intact.

V5 does not connect a payment processor and does not claim a legal SLA guarantee. Cost accounting uses integer cents internally.

## Security

Browser clients use the Supabase publishable key. Server routes and workers use the server-only secret key. All V5 tables are RLS-protected; browser grants are read-only. Enterprise RPC execution is service-role only. Invitation raw tokens are returned once and only SHA-256 hashes are stored. Secrets, private keys, raw prompts and raw connector payloads are excluded from enterprise audit and usage records.

## Runtime

User intent -> authenticated API -> enterprise admission -> V4 planner -> validated DAG -> leased worker -> parallel execution -> scoped connectors -> verification -> usage and audit -> durable result.

## Local setup

1. Use a dedicated Supabase project for AI Orchestra; do not reuse the retired Inbox9 project.
2. Apply V2, V3, V4 and V5 migrations in order.
3. Configure Supabase browser/server values, V4 credential key material and ENTERPRISE_DEFAULT_REGION.
4. Use Node.js 22+.
5. Run npm install, npm run test:core, npm run typecheck and npm run build.