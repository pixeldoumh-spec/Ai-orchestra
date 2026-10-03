# Threat model

Tenant escape: organization-scoped route resolution, foreign keys and RLS on every V5 table.

Privilege escalation: explicit enterprise permission matrix; governance mutations require owner/admin; ownership transfer is not exposed through the general role endpoint.

Budget bypass: database task-admission trigger checks max task cost, monthly task limits, monthly spend plus reservations and allowed region. Task budget is immutable after admission.

Concurrency bypass: transaction-locked trigger checks running task count whenever a task enters running state.

Resource exhaustion: database agent/member ceilings, task reservations and monthly limits.

Invitation abuse: cryptographically random one-time token, SHA-256 hash storage, seven-day expiry and signed-in email match.

Audit tampering: browser select-only access plus database triggers rejecting audit UPDATE/DELETE.

Sensitive data exposure: enterprise telemetry stores identifiers, hashes, metadata and integer cost rather than raw prompts or connector payloads.

Regional bypass: execution_region is assigned and validated in the database before task insertion.

Availability: V4 circuit breaking provides connector resilience. V5 stores SLA targets and region policy but does not simulate multi-region failover or claim an external SLA.