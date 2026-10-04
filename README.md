# AI Orchestra V6.1

A provider-neutral AI control plane for planning, executing, verifying, protecting and governing multi-agent workflows.

## V6.1 real intelligence layer

V6.1 activates the real model runtime behind the existing V6 control plane. The application uses the OpenAI Responses API for model execution, Structured Outputs for workflow planning and verification, native function calling for application-owned tools, bounded multi-turn tool loops, model-specific reasoning controls, token/cached-input metering, request timeouts and provider error normalization.

The default production model strategy is:
- Planner: `gpt-5.5` with high reasoning effort.
- Research/analysis/writer agents: `gpt-5.4-mini` with medium reasoning effort.
- Verifier: `gpt-5.5` with high reasoning effort.

## V6 enterprise control plane

V6 provides fine-grained organization RBAC, teams, one-time invitations, plan entitlements, database-enforced task admission, monthly task and spend ceilings, reservations, usage metering, audit trails, regional execution, signed agent identities, encrypted agent-to-agent messages, trust edges and durable message delivery.

## Security

Browser clients use the Supabase publishable key. Server routes and workers use the server-only Supabase secret key. All V6 tables are RLS-protected; browser grants are read-only. Enterprise RPC execution is service-role only. Invitation raw tokens are returned once and only SHA-256 hashes are stored. Secrets, private keys, raw prompts and raw connector payloads are excluded from enterprise audit and usage records.

OpenAI credentials must be runtime secrets. They must never be placed in browser variables, Git history, `.env.example`, or build-only variables.

## Runtime

User goal
→ authenticated API
→ enterprise admission
→ model planner
→ validated DAG
→ leased worker
→ real model turns
→ native function calls
→ scoped tools/connectors
→ independent verification
→ usage and audit
→ durable result.

## Activation

Keep `AI_MODEL_PROVIDER=mock` for safe development without an OpenAI key.

For production model execution, configure these on the live Cloudflare Worker:
`OPENAI_API_KEY` as a runtime Secret;
`AI_MODEL_PROVIDER=openai`;
`OPENAI_MODEL=gpt-5.4-mini`;
`AI_PLANNER_MODEL=gpt-5.5`;
`AI_VERIFIER_MODEL=gpt-5.5`.

The cost estimator includes current built-in rates for GPT-5.5, GPT-5.4 mini and GPT-5.4, while positive environment-variable overrides remain supported.

## Engineering notes

The Responses adapter uses `store:false` and replays response output items between bounded turns so the runtime does not depend on provider-side persisted conversation state. Reasoning/function-call items are retained in-memory only for the active task turn and are not written into enterprise audit records.

Tool calls are never executed directly by the model. The model proposes a function call, the application validates the declared tool/permission, and the existing gateway decides whether to execute, request approval, or reject it. High-risk external side effects remain approval-gated.

The planner and verifier use strict Structured Outputs. Work agents use native function calling and can continue for a bounded number of turns after tool results are returned. No hidden chain-of-thought is requested or persisted.

## Local checks

1. Use Node.js 22+.
2. Run `npm install`.
3. Run `npm run test:core`.
4. Run `npm run typecheck`.
5. Run `npm run build`.


## V6.2 real tool & evidence layer

V6.2 adds live web research through the Responses API `web_search` tool, tenant-scoped document ingestion into a private Supabase Storage bucket plus an OpenAI vector store, structured evidence packets, source citations and real read-only HTTP connector execution.

### Knowledge flow

Browser upload
→ authenticated tenant route
→ private Supabase Storage
→ OpenAI Files API (`purpose=user_data`)
→ tenant vector store
→ `file_search`
→ cited model result
→ immutable evidence packet.

OpenAI's Responses API provides hosted web search with URL citations and hosted file search over vector stores. The application persists only bounded provenance/citation metadata and excerpts, not raw connector credentials or hidden chain-of-thought. citeturn517965search0turn517965search1

### Connector flow

Model
→ declared `connector.http.get`
→ tenant trust/binding/credential checks
→ HTTPS same-origin path resolution
→ authenticated GET
→ size + timeout bounds
→ connector health/circuit update
→ evidence packet
→ model.

High-risk `external.action` remains approval-gated and is not converted into an unrestricted side-effect engine in V6.2.

### Supported document ingestion

The V6.2 ingestion route accepts common PDFs, DOC/DOCX, PPTX, Markdown, text, CSV, JSON, HTML and supported source-code formats up to 50 MB. Supabase recommends standard uploads for smaller files and resumable uploads for larger files; the V6.2 HTTP route intentionally keeps a bounded 50 MB tenant upload envelope for predictable Worker behavior. citeturn711246search0turn456443search7

### Runtime configuration

Add `OPENAI_API_KEY` as a Cloudflare Worker runtime Secret. Keep `AI_MODEL_PROVIDER=mock` until you are ready to activate real model traffic.

For real V6.2 tool execution:
`AI_MODEL_PROVIDER=openai`
`OPENAI_MODEL=gpt-5.4-mini`
`AI_PLANNER_MODEL=gpt-5.5`
`AI_VERIFIER_MODEL=gpt-5.5`
`AI_WEB_SEARCH_CONTEXT_SIZE=medium`
`AI_FILE_SEARCH_MAX_RESULTS=8`

Supabase Storage must remain private; file access is controlled by the authenticated tenant boundary and server-side service-role routes. citeturn456443search4
