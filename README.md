# AI Orchestra V6.3

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


## Cloudflare Workers AI runtime

The Cloudflare deployment now has a native Workers AI binding (AI) and a provider adapter for the GPT-OSS Responses API. Cloudflare documents that Workers AI bindings are exposed as env.AI, and the GPT-OSS 20B/120B models support the Responses API and function calling. citeturn941580search0turn527232search1turn527232search8

The production Wrangler configuration selects cloudflare_workers_ai with @cf/openai/gpt-oss-20b by default. The adapter uses rejectIfBusy to fail fast on temporary capacity pressure, caps output tokens, bounds request time, detects Cloudflare's daily-allocation error, and records estimated Neuron usage without storing provider secrets. Cloudflare's current Workers AI Free allocation is 10,000 Neurons per day and resets at 00:00 UTC; exceeding that allocation on Workers Free causes subsequent inference to fail until reset. citeturn941580search1turn755134search0turn755134search6

Workers AI's hosted web-search/file-search tools are not silently passed to this adapter because those tools are not equivalent to Cloudflare's native inference binding. V6.2's OpenAI-hosted grounding path remains available when AI_MODEL_PROVIDER=openai; Workers AI currently provides the model execution/runtime layer and application-owned function tools. This separation avoids pretending that a provider-specific tool exists when it does not.

For local development without a Cloudflare runtime, keep AI_MODEL_PROVIDER=mock. For Cloudflare deployment, the checked-in wrangler.jsonc supplies the AI binding and Workers AI runtime variables.
## V6.3 real agents

V6.3 turns the four runtime roles into explicit specializations rather than generic prompts.

- Research Agent: evidence gathering, source-quality discipline, conflict detection and explicit unknowns.
- Analysis Agent: contradiction detection, evidence-to-conclusion reasoning and uncertainty preservation.
- Writer Agent: user-facing synthesis constrained to verified upstream material.
- Verifier Agent: adversarial completeness and support checks with strict structured pass/fail output.

The planner now receives specialization metadata and rejects plans that do not cover Research, Analysis, Writer and Verifier. Each executed step carries its resolved specialization in model-completion telemetry. Failed steps use bounded exponential retry with jitter, then enter the existing bounded replan path when retries are exhausted. Verifier rejection is treated as a real step failure and therefore cannot finalize a task.

The production runtime remains provider-neutral. When the live provider is Cloudflare Workers AI, these specializations run on the configured Workers AI model; when OpenAI is selected, the same specialization contracts run through the OpenAI Responses adapter.

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

High-risk `external.action` remains approval-gated. After approval, the exact encrypted intent is atomically claimed and executed through the bound HTTPS connector with idempotency, credential policy, circuit state, timeout/size bounds and durable execution provenance. This is a connector execution plane, not an unrestricted internet side-effect engine.

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

### Evidence model

Each research or execution step can emit an immutable evidence packet. A packet records the source class, source URL/title or tenant document/connector reference, bounded claim/excerpt, optional retrieval confidence, content hash and capture metadata. The result shown to the user can therefore be traced back to durable provenance without persisting hidden chain-of-thought or connector credentials.

### Connector execution safety

A high-risk external action is first represented as an encrypted, signed connector intent. Human approval changes the intent to `approved`; the executor then atomically claims it as `executing`, resolves the already-authorized connector binding and credential, revalidates the same-origin path and method, executes with bounded timeout/response size and an idempotency key, records a connector evidence packet and closes the request as `executed` or `failed`. The downstream connector should honor the idempotency key for non-read actions.

## V6.4 — Agent Network

AI Orchestra now has a governed agent-to-agent plane. Specialized agents can autonomously delegate bounded work through `agent.delegate`, receive a signed response, and keep task/correlation/reply lineage intact.

The network is protected by tenant policy, explicit source→target trust edges, Ed25519 signatures, encrypted payloads, TTLs, rate limits, delegation-depth and hop limits. Organization policy is enforced both in application code and PostgreSQL admission triggers.

The live network surface is `/network`; policy administration is available to owner/admin roles. Autonomous delegation never inherits hidden authority or connector side effects from the parent agent, and final task verification remains mandatory.
