# V6 — Agent-to-agent network

V6 adds a durable internal network for agents on top of the V5 enterprise control plane.

## Trust and identity

Communication is allowed only across an explicit same-organization trust edge for an exact source and target agent. Each edge specifies allowed message kinds, scopes, payload size and per-minute rate.

Every message contains a versioned canonical envelope and is signed with the sender agent's Ed25519 identity. V6 keeps a historical public-key registry so verification material survives identity rotation. Private identities remain encrypted by the existing AES-256-GCM vault.

## Message security

Payloads are encrypted at rest. The signed envelope contains a SHA-256 payload hash, preventing an attacker from modifying the payload without detection. Each message has a unique nonce, bounded 10-second-to-1-hour TTL, organization-scoped routing, and immutable signed fields after enqueue.

## Delivery

Messages are durable and move through queued → delivered → acknowledged/failed. A service-role-only database function claims inbox work atomically with `FOR UPDATE SKIP LOCKED`; advisory locking prevents overlapping claims for the same agent. Expired messages become terminal.

Responses must reference a matching request/delegation from the opposite agent. Delegation is a first-class protocol kind but is restricted to an `agent.delegation...` scope and is not enabled by the default operator UI.

## Governance

V6 extends enterprise RBAC with:
- `network.read`
- `network.send`
- `network.ack`
- `network.manage`
- `network.payload.read`

Browser roles never write network rows. Payload decryption is separately permissioned so auditors/viewers see network metadata without sensitive message bodies.

## API

- `GET/POST /api/network`
- `POST /api/network/claim`
- `POST /api/network/messages/:id/ack`
- `GET/POST /api/network/peers`
- `DELETE /api/network/peers/:id`

The reusable server primitives are `sendAgentMessage`, `claimNetworkMessages`, and `acknowledgeNetworkMessage`.

V6 does not open public agent sockets, does not introduce cross-organization federation, and does not enable arbitrary internet side effects.

## Migration

Apply `supabase/migrations/20261004_agent_orchestrator_v6.sql` after the V5 and V5.1 migrations. The migration is additive.
