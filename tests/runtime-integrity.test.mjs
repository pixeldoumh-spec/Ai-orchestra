import assert from "node:assert/strict";
import test from "node:test";
import {
  canTransitionTaskStatus,
  isTerminalTaskStatus,
  ownsLease,
  safeWorkerExitStatus,
  stepNeedsRecovery,
  isDispatchEligible,
  isStaleLeaseTakeoverEligible,
} from "../.tmp-core/runtime.js";

test("V6.6.1 terminal task state is immutable", () => {
  for (const terminal of ["verified", "failed", "cancelled"]) {
    assert.equal(isTerminalTaskStatus(terminal), true);
    assert.equal(canTransitionTaskStatus(terminal, terminal), true);
    for (const next of ["queued", "running", "awaiting_approval"]) {
      assert.equal(canTransitionTaskStatus(terminal, next), false);
    }
  }
  assert.equal(canTransitionTaskStatus("queued", "running"), true);
  assert.equal(canTransitionTaskStatus("running", "verified"), true);
  assert.equal(canTransitionTaskStatus("running", "failed"), true);
});

test("V6.6.1 lease generation fences a crashed worker", () => {
  const current = {
    status: "running",
    lease_owner: "worker-B",
    lease_generation: 8,
  };
  assert.equal(ownsLease(current, "worker-B", 8), true);
  assert.equal(ownsLease(current, "worker-A", 7), false);
  assert.equal(ownsLease(current, "worker-A", 8), false);
  assert.equal(ownsLease(current, "worker-B", 7), false);
});

test("V6.6.1 stale step generation is recoverable only after takeover", () => {
  assert.equal(stepNeedsRecovery(null, 8), true);
  assert.equal(stepNeedsRecovery(7, 8), true);
  assert.equal(stepNeedsRecovery(8, 8), false);
});

test("V6.6.1 worker exit policy never preserves running without ownership", () => {
  assert.equal(safeWorkerExitStatus({ status: "running" }), "queued");
  assert.equal(safeWorkerExitStatus({ status: "verified" }), "terminal");
  assert.equal(safeWorkerExitStatus({ status: "failed" }), "terminal");
  assert.equal(safeWorkerExitStatus({ status: "cancelled" }), "terminal");
  assert.equal(safeWorkerExitStatus({ status: "awaiting_approval" }), "terminal");
});


test("Queue integrity: stale heartbeat cannot override an active lease", () => {
  const now = Date.parse("2026-10-06T07:30:00.000Z");
  const activeLease = {
    status: "running",
    lease_until: "2026-10-06T07:40:00.000Z",
    last_heartbeat_at: "2026-10-06T07:20:00.000Z",
  };
  assert.equal(isStaleLeaseTakeoverEligible(activeLease, now, 300_000), false);
  assert.equal(isDispatchEligible(activeLease, now, 120_000, 45_000), false);
});

test("Queue integrity: expired lease is the takeover boundary", () => {
  const now = Date.parse("2026-10-06T07:30:00.000Z");
  const expiredLease = {
    status: "running",
    lease_until: "2026-10-06T07:29:59.000Z",
    last_heartbeat_at: "2026-10-06T07:29:59.500Z",
  };
  assert.equal(isStaleLeaseTakeoverEligible(expiredLease, now, 300_000), true);
  assert.equal(isDispatchEligible(expiredLease, now, 120_000, 45_000), true);
});
