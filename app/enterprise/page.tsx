"use client";


import { OrchestraShell } from "@/components/OrchestraShell";

import { useEffect, useMemo, useState } from "react";

export default function EnterprisePage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteToken, setInviteToken] = useState("");
  const [teamMemberUserId, setTeamMemberUserId] = useState("");
  const [teamMemberTeamId, setTeamMemberTeamId] = useState("");
  const [teamMemberRole, setTeamMemberRole] = useState("member");

  async function load() {
    setLoading(true);
    const r = await fetch("/api/enterprise");
    const b = await r.json();
    if (!r.ok) {
      setMessage(b.error ?? "Enterprise control plane unavailable");
      setLoading(false);
      return;
    }
    setData(b);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(section: string, value: any) {
    setMessage("Saving…");
    const r = await fetch("/api/enterprise", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ section, value }),
    });
    const b = await r.json();
    if (!r.ok) {
      setMessage(b.error ?? "Save failed");
      return;
    }
    await load();
    setMessage("Saved");
  }

  async function createTeam() {
    const r = await fetch("/api/enterprise/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: teamName, description: teamDescription }),
    });
    const b = await r.json();
    if (!r.ok) {
      setMessage(b.error ?? "Team creation failed");
      return;
    }
    setTeamName("");
    setTeamDescription("");
    await load();
  }

  async function invite() {
    const r = await fetch("/api/enterprise/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const b = await r.json();
    if (!r.ok) {
      setMessage(b.error ?? "Invitation failed");
      return;
    }
    setInviteToken(b.token ?? "");
    setInviteEmail("");
    await load();
  }


  async function setRole(userId: string, role: string) {
    const r = await fetch("/api/enterprise/members/" + encodeURIComponent(userId), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { setMessage(b.error ?? "Role update failed"); return; }
    setMessage("Member role updated."); await load();
  }

  async function addToTeam() {
    if (!teamMemberTeamId || !teamMemberUserId) return;
    const r = await fetch("/api/enterprise/teams/" + encodeURIComponent(teamMemberTeamId) + "/members", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: teamMemberUserId, role: teamMemberRole }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { setMessage(b.error ?? "Team membership update failed"); return; }
    setMessage("Team membership saved.");
  }

  if (loading) {
    return (
      <OrchestraShell title="Workspace" section="Workspace"><div className="shell">
        <section className="card"><b>Loading enterprise control plane…</b></section>
      </div></OrchestraShell>
    );
  }

  const e = data?.entitlements;
  const p = data?.policy;
  const u = data?.usage;

  return (
    <OrchestraShell title="Workspace" section="Workspace"><div className="shell">
      {message && <div className="card" style={{ marginBottom: 16, padding: 14 }}>{message}</div>}

      <section className="hero card">
        <div>
          <div className="pill">PRODUCT + GOVERNANCE + COLLABORATION</div>
          <h2>Plans, billing, quotas, teams, connectors and production governance in one place.</h2>
          <p className="muted">
            V7 connects the production runtime to subscription-aware plan provisioning, quota enforcement,
            team collaboration and a governed connector marketplace while preserving the tenant boundary.
          </p>
        </div>
        <div className="healthGrid">
          <Metric label="Monthly spend" value={"$" + ((u?.spendCents ?? 0) / 100).toFixed(2) + " / $" + ((e?.monthlySpendLimitCents ?? 0) / 100).toFixed(2)} />
          <Metric label="Tasks" value={(u?.taskCount ?? 0) + " / " + (e?.monthlyTaskLimit ?? 0)} />
          <Metric label="Billing" value="Stripe-ready" />
          <Metric label="Marketplace" value="Governed installs" />
        </div>
      </section>

      <OperationsDashboard operations={data?.operations} />

      <section className="layout">
        <div className="card">
          <div className="sectionTitle">Entitlements</div>
          <div className="metricGrid">
            <Metric label="Max agents" value={String(e?.maxAgents)} />
            <Metric label="Max members" value={String(e?.maxMembers)} />
            <Metric label="Max task" value={"$" + ((e?.maxTaskCostCents ?? 0) / 100).toFixed(2)} />
            <Metric label="Retention" value={(e?.retentionDays ?? 0) + "d"} />
          </div>
          <div className="muted tiny">Plan changes remain an explicit admin action.</div>
        </div>

        <div className="card">
          <div className="sectionTitle">External action policy</div>
          <label>
            <input
              type="checkbox"
              checked={Boolean(p?.requireApprovalForExternal)}
              onChange={(ev) => save("policy", { ...p, requireApprovalForExternal: ev.target.checked })}
            />{" "}
            Require approval for external actions
          </label>
          <label>
            <input
              type="checkbox"
              checked={Boolean(p?.allowExternalActions)}
              onChange={(ev) => save("policy", { ...p, allowExternalActions: ev.target.checked })}
            />{" "}
            Allow external action preparation
          </label>
          <div className="muted small">Connector side effects remain governed and approval-gated.</div>
        </div>
      </section>

      <section className="layout">
        <div className="card">
          <div className="sectionTitle">Teams</div>
          {(data?.teams ?? []).map((t: any) => (
            <div className="agentRow" key={t.id}>
              <div>
                <b>{t.name}</b>
                <div className="muted small">{t.description || "No description"}</div>
              </div>
            </div>
          ))}
          <div className="composerRow">
            <input placeholder="Team name" value={teamName} onChange={(x) => setTeamName(x.target.value)} />
            <input placeholder="Description" value={teamDescription} onChange={(x) => setTeamDescription(x.target.value)} />
            <button disabled={!teamName.trim()} onClick={createTeam}>Create team</button>
          </div>
        </div>

        <div className="card">
          <div className="sectionTitle">Members & invitations</div>
          {(data?.members ?? []).map((m: any) => (
            <div className="agentRow" key={m.user_id}>
              <div>
                <b>{String(m.user_id).slice(0, 8)}…</b>
                <div className="muted small">{m.role}</div>
              </div>
              {m.role !== "owner" && (
                <select value={m.role} onChange={(ev) => void setRole(m.user_id, ev.target.value)}>
                  <option value="member">member</option><option value="operator">operator</option><option value="billing">billing</option><option value="auditor">auditor</option><option value="viewer">viewer</option><option value="admin">admin</option>
                </select>
              )}
            </div>
          ))}
          {(data?.teams ?? []).length > 0 && (
            <div className="composerRow">
              <select value={teamMemberUserId} onChange={(x) => setTeamMemberUserId(x.target.value)}>
                <option value="">Member</option>{(data?.members ?? []).map((m: any) => <option key={m.user_id} value={m.user_id}>{String(m.user_id).slice(0, 8)}…</option>)}
              </select>
              <select value={teamMemberTeamId} onChange={(x) => setTeamMemberTeamId(x.target.value)}>
                <option value="">Team</option>{(data?.teams ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <select value={teamMemberRole} onChange={(x) => setTeamMemberRole(x.target.value)}><option value="member">member</option><option value="lead">lead</option></select>
              <button disabled={!teamMemberUserId || !teamMemberTeamId} onClick={() => void addToTeam}>Add to team</button>
            </div>
          )}
          <div className="composerRow">
            <input type="email" placeholder="Invite email" value={inviteEmail} onChange={(x) => setInviteEmail(x.target.value)} />
            <select value={inviteRole} onChange={(x) => setInviteRole(x.target.value)}>
              <option>member</option>
              <option>operator</option>
              <option>billing</option>
              <option>auditor</option>
              <option>viewer</option>
            </select>
            <button disabled={!inviteEmail.includes("@")} onClick={invite}>Create invite</button>
          </div>
          {inviteToken && (
            <div className="resultBox">
              <div className="muted small">ONE-TIME INVITATION TOKEN</div>
              <code>{inviteToken}</code>
              <div className="muted tiny">Stored server-side only as a hash.</div>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="sectionTitle">SLA definition</div>
        {(data?.sla ?? []).map((s: any) => (
          <div className="agentRow" key={s.id}>
            <div>
              <b>{s.name}</b>
              <div className="muted small">
                {(s.availabilityBps / 100).toFixed(2)}% availability · {Math.round(s.taskP95Ms / 1000)}s task p95 · {s.supportResponseMinutes}m support response
              </div>
            </div>
            <span>{s.active ? "active" : "inactive"}</span>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="sectionTitle">Audit preview</div>
        {(data?.auditPreview ?? []).map((a: any) => (
          <div className="agentRow" key={a.id}>
            <div>
              <b>{a.action}</b>
              <div className="muted tiny">{a.resourceType} · {a.createdAt}</div>
            </div>
            <span>{a.result}</span>
          </div>
        ))}
        {!data?.auditPreview?.length && <div className="empty">Configuration changes will appear here.</div>}
      </section>

      <section className="card">
        <div className="sectionTitle">Regional policy</div>
        <div className="muted small">
          Primary: <b>{e?.primaryRegion}</b> · Allowed: {(e?.allowedRegions ?? []).join(", ")} · Residency: {e?.dataResidency}
        </div>
      </section>
    </div></OrchestraShell>
  );
}

function OperationsDashboard({ operations }: { operations: any }) {
  const summary = operations?.summary ?? {};
  const tasks = operations?.tasks ?? {};
  const workers = operations?.workers ?? {};
  const daily = Array.isArray(operations?.daily) ? operations.daily : [];
  const models = Array.isArray(operations?.models) ? operations.models : [];

  const callCount = Number(summary.calls ?? 0);
  const failedCalls = Number(summary.failed_calls ?? 0);
  const fallbackCalls = Number(summary.fallback_calls ?? 0);
  const successRate = callCount ? ((callCount - failedCalls) / callCount) * 100 : 100;
  const fallbackRate = callCount ? (fallbackCalls / callCount) * 100 : 0;
  const maxDailyCalls = useMemo(
    () => Math.max(1, ...daily.map((d: any) => Number(d.calls ?? 0))),
    [daily],
  );

  return (
    <section className="card opsDashboard">
      <div className="taskHead">
        <div>
          <div className="sectionTitle">Production operations</div>
          <div className="muted small">Last 30 days · tenant-scoped model, worker and task telemetry</div>
        </div>
        <span className="status verified">LIVE TELEMETRY</span>
      </div>

      <div className="healthGrid opsMetrics">
        <Metric label="Model calls" value={String(callCount)} />
        <Metric label="Success rate" value={successRate.toFixed(1) + "%"} />
        <Metric label="Fallback rate" value={fallbackRate.toFixed(1) + "%"} />
        <Metric label="Model p95" value={Math.round(Number(summary.p95_latency_ms ?? 0)) + "ms"} />
        <Metric label="Input tokens" value={String(Number(summary.input_tokens ?? 0))} />
        <Metric label="Output tokens" value={String(Number(summary.output_tokens ?? 0))} />
        <Metric label="Workers p95" value={Math.round(Number(workers.p95_latency_ms ?? 0)) + "ms"} />
        <Metric label="Neurons" value={String(Number(summary.neurons ?? 0))} />
      </div>

      <div className="layout opsLayout">
        <div>
          <div className="sectionTitle">Model reliability</div>
          {models.length === 0 ? (
            <div className="empty">No model executions recorded yet.</div>
          ) : (
            models.slice(0, 8).map((m: any) => (
              <div className="agentRow" key={m.provider + ":" + m.model}>
                <div>
                  <b>{m.model}</b>
                  <div className="muted small">
                    {m.provider} · {m.successful_calls}/{m.calls} successful · {m.fallback_calls} fallbacks · p95 {Math.round(Number(m.p95_latency_ms ?? 0))}ms
                  </div>
                </div>
                <span className="status mini">{Number(m.neurons ?? 0)} N</span>
              </div>
            ))
          )}
        </div>

        <div>
          <div className="sectionTitle">Daily execution</div>
          {daily.length === 0 ? (
            <div className="empty">Daily telemetry will populate after the first run.</div>
          ) : (
            daily.slice(-14).map((d: any) => (
              <div key={d.day} className="opsDay">
                <div className="opsDayMeta">
                  <span>{d.day}</span>
                  <b>{d.calls}</b>
                </div>
                <div className="opsBar">
                  <span style={{ width: Math.max(4, (Number(d.calls ?? 0) / maxDailyCalls) * 100) + "%" }} />
                </div>
                <div className="muted tiny">
                  {d.successful_calls} ok · {d.failed_calls} failed · {d.fallback_calls} fallback
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="muted small">
        Tasks: {Number(tasks.task_count ?? 0)} · verified {Number(tasks.verified_count ?? 0)} · failed {Number(tasks.failed_count ?? 0)} · cancelled {Number(tasks.cancelled_count ?? 0)} · background runs {Number(workers.runs ?? 0)}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="muted small">{label}</div>
      <b>{value}</b>
    </div>
  );
}
