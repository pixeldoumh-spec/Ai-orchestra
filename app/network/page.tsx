"use client";


import { OrchestraShell } from "@/components/OrchestraShell";

import { useEffect, useState, type CSSProperties } from "react";

type Agent = any;
type Peer = any;
type Message = any;
type NetworkPolicy = any;

export default function NetworkPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [policy, setPolicy] = useState<NetworkPolicy | null>(null);
  const [org, setOrg] = useState<any>(null);
  const [peerSource, setPeerSource] = useState("");
  const [peerTarget, setPeerTarget] = useState("");
  const [messageSource, setMessageSource] = useState("");
  const [messageTarget, setMessageTarget] = useState("");
  const [scope, setScope] = useState("task.coordination");
  const [subject, setSubject] = useState("Coordination request");
  const [body, setBody] = useState("{\n  \"instruction\": \"Pass verified context to the next agent\"\n}");
  const [status, setStatus] = useState("");

  async function load() {
    const a = await fetch("/api/agents");
    if (!a.ok) {
      setStatus(a.status === 401 ? "Sign in to access the agent network." : `Network control plane unavailable (HTTP ${a.status})`);
      return;
    }
    const ad = await a.json();
    setAgents(ad.agents ?? []);
    setOrg(ad.organization);

    const [ps, ms, pol] = await Promise.all([
      fetch("/api/network/peers?organizationId=" + encodeURIComponent(ad.organization.id)),
      fetch("/api/network?organizationId=" + encodeURIComponent(ad.organization.id) + "&limit=50"),
      fetch("/api/network/policy?organizationId=" + encodeURIComponent(ad.organization.id)),
    ]);
    if (ps.ok) setPeers((await ps.json()).peers ?? []);
    if (ms.ok) {
      const md = await ms.json();
      setMessages(md.messages ?? []);
      setStats(md.stats);
      setPolicy(md.policy ?? null);
    }
    if (pol.ok) setPolicy((await pol.json()).policy ?? null);
  }

  useEffect(() => {
    void load();
    const h = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(h);
  }, []);

  async function createPeer() {
    if (!org) return;
    setStatus("Authorizing trust edge…");
    const r = await fetch("/api/network/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceAgentId: peerSource,
        targetAgentId: peerTarget,
        allowedMessageTypes: ["request", "response", "event", "delegation"],
        allowedScopes: [scope],
        maxPayloadBytes: 65536,
        rateLimitPerMinute: 60,
      }),
    });
    const b = await r.json();
    setStatus(r.ok ? "Trust edge active." : (b.error ?? "Peer creation failed"));
    if (r.ok) await load();
  }

  async function revokePeer(id: string) {
    if (!org) return;
    const r = await fetch("/api/network/peers/" + id + "?organizationId=" + encodeURIComponent(org.id), { method: "DELETE" });
    const b = await r.json();
    setStatus(r.ok ? "Trust edge revoked." : (b.error ?? "Revocation failed"));
    await load();
  }

  async function savePolicy(next: NetworkPolicy) {
    if (!org) return;
    setStatus("Applying organization network policy…");
    const r = await fetch("/api/network/policy?organizationId=" + encodeURIComponent(org.id), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    const b = await r.json();
    setStatus(r.ok ? "Network policy updated." : (b.error ?? "Policy update failed"));
    if (r.ok) setPolicy(b.policy);
  }

  async function send() {
    if (!org) return;
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      setStatus("Payload must be valid JSON.");
      return;
    }
    setStatus("Signing and enqueueing…");
    const r = await fetch("/api/network", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationId: org.id,
        senderAgentId: messageSource,
        recipientAgentId: messageTarget,
        subject,
        payload,
        scope,
        kind: "event",
        ttlSeconds: policy?.defaultTtlSeconds ?? 300,
        priority: 60,
      }),
    });
    const b = await r.json();
    setStatus(r.ok ? "Message queued with signed provenance." : (b.error ?? "Message rejected"));
    if (r.ok) await load();
  }

  async function claim() {
    if (!org || !messageTarget) return;
    setStatus("Claiming recipient inbox…");
    const r = await fetch("/api/network/claim?organizationId=" + encodeURIComponent(org.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: messageTarget, limit: 20 }),
    });
    const b = await r.json();
    setStatus(r.ok ? "Inbox claimed: " + (b.messages?.length ?? 0) + " message(s)." : (b.error ?? "Claim failed"));
    await load();
  }

  async function ack(message: Message, success: boolean) {
    if (!org) return;
    const r = await fetch("/api/network/messages/" + message.messageId + "/ack?organizationId=" + encodeURIComponent(org.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: message.recipientAgentId, success }),
    });
    const b = await r.json();
    setStatus(r.ok ? (success ? "Message acknowledged." : "Message failed.") : (b.error ?? "Acknowledgement failed"));
    await load();
  }

  return (
    <OrchestraShell title="Agent network" section="Agent network"><div className="shell">
      <section className="hero card">
        <div>
          <div className="pill">V6.4 · SIGNED · ENCRYPTED · POLICY-GOVERNED</div>
          <h2>Agents can delegate bounded work and return signed results without bypassing the control plane.</h2>
          <p className="muted">Every hop is bound to a tenant, trust edge, policy scope, correlation chain, hop/depth budget and Ed25519 identity.</p>
        </div>
        <div className="healthGrid">
          <Metric label="Active peers" value={String(stats?.activePeers ?? 0)} />
          <Metric label="Queued" value={String(stats?.queued ?? 0)} />
          <Metric label="Delegations queued" value={String(stats?.delegationQueued ?? 0)} />
          <Metric label="Delegations completed" value={String(stats?.delegationCompleted ?? 0)} />
        </div>
      </section>

      <section className="card" style={{ padding: 20, marginTop: 16 }}>
        <div className="sectionTitle">Organization network policy</div>
        {policy ? (
          <>
            <div className="composerRow">
              <label className="policyToggle"><input type="checkbox" checked={policy.enabled} onChange={e => setPolicy({ ...policy, enabled: e.target.checked })} /> Network enabled</label>
              <label className="policyToggle"><input type="checkbox" checked={policy.allowDelegation} onChange={e => setPolicy({ ...policy, allowDelegation: e.target.checked })} /> Autonomous delegation enabled</label>
              <button onClick={() => savePolicy(policy)}>Save policy</button>
            </div>
            <div className="healthGrid" style={{ marginTop: 12 }}>
              <Metric label="Max delegation depth" value={String(policy.maxDelegationDepth)} />
              <Metric label="Max hops" value={String(policy.maxHops)} />
              <Metric label="Payload cap" value={Math.round(policy.maxPayloadBytes / 1024) + " KiB"} />
              <Metric label="Rate cap" value={String(policy.rateLimitPerMinute) + "/min"} />
            </div>
          </>
        ) : (
          <div className="empty">Loading policy…</div>
        )}
      </section>

      <section className="layout">
        <div className="card" style={{ padding: 20 }}>
          <div className="sectionTitle">Trust graph</div>
          <div className="composerRow">
            <select value={peerSource} onChange={e => setPeerSource(e.target.value)} style={fieldStyle}>
              <option value="">Source agent</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select value={peerTarget} onChange={e => setPeerTarget(e.target.value)} style={fieldStyle}>
              <option value="">Target agent</option>
              {agents.filter(a => a.id !== peerSource).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <input value={scope} onChange={e => setScope(e.target.value)} placeholder="Allowed scope" style={fieldStyle} />
          <button onClick={createPeer} disabled={!peerSource || !peerTarget || !scope}>Create trust edge</button>
          {peers.map(p => (
            <div className="agentRow" key={p.id}>
              <div className="agentDot" />
              <div>
                <b>{p.sourceAgentId} → {p.targetAgentId}</b>
                <div className="muted small">{p.allowedMessageTypes.join(" · ")} · {p.allowedScopes.join(" · ")} · {p.rateLimitPerMinute}/min</div>
              </div>
              <div className="agentRight">
                <span>{p.status}</span>
                {p.status === "active" && <button className="secondary" onClick={() => revokePeer(p.id)}>Revoke</button>}
              </div>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 20 }}>
          <div className="sectionTitle">Signed messages</div>
          <select value={messageSource} onChange={e => setMessageSource(e.target.value)} style={fieldStyle}>
            <option value="">Sender agent</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select value={messageTarget} onChange={e => setMessageTarget(e.target.value)} style={fieldStyle}>
            <option value="">Recipient agent</option>
            {agents.filter(a => a.id !== messageSource).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject" style={fieldStyle} />
          <textarea value={body} onChange={e => setBody(e.target.value)} style={{ ...fieldStyle, minHeight: 150, fontFamily: "ui-monospace,monospace" }} />
          <div className="composerRow">
            <button onClick={send} disabled={!org || !messageSource || !messageTarget || !subject}>Sign + enqueue</button>
            <button className="secondary" onClick={claim} disabled={!org || !messageTarget}>Claim recipient inbox</button>
          </div>
          <div className="muted small" style={{ marginTop: 10 }}>Delegation is model-driven through the agent.delegate tool; direct delegation messages still require an explicit agent.delegation trust scope.</div>
        </div>
      </section>

      <section className="card" style={{ padding: 20, marginTop: 16 }}>
        <div className="sectionTitle">Correlation + delivery chain</div>
        {messages.length === 0 ? <div className="empty">No network messages yet.</div> : messages.map(m => (
          <div className="agentRow" key={m.id}>
            <div className="agentDot" />
            <div>
              <b>{m.subject}</b>
              <div className="muted small">{m.senderAgentId} → {m.recipientAgentId} · {m.kind} · {m.scope}</div>
              <div className="muted small">
                {m.status} · correlation {m.correlationId ?? "none"} · reply {m.replyToMessageId ?? "root"} · depth {m.delegationDepth ?? 0} · hops {m.hopCount ?? 0}
              </div>
              <div className="muted small">task {m.taskId ?? "unbound"} · created {new Date(m.createdAt).toLocaleString()}</div>
              {m.payload !== undefined && <pre style={{ margin: "8px 0 0", whiteSpace: "pre-wrap", color: "var(--muted)", fontSize: 11 }}>{JSON.stringify(m.payload, null, 2)}</pre>}
            </div>
            <div className="agentRight">
              {m.status === "delivered" && !["acknowledged", "failed", "expired"].includes(m.status) && <>
                <button onClick={() => ack(m, true)}>Ack</button>
                <button className="secondary" onClick={() => ack(m, false)}>Fail</button>
              </>}
            </div>
          </div>
        ))}
      </section>
      {status && <div className="error">{status}</div>}
    </div></OrchestraShell>
  );
}

const fieldStyle: CSSProperties = { width: "100%", marginTop: 10, background: "#08120c", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 11, padding: 12, font: "inherit" };
const policyToggle: CSSProperties = { display: "flex", gap: 8, alignItems: "center", padding: 10, border: "1px solid var(--line)", borderRadius: 11 };

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><div className="muted small">{label}</div><b>{value}</b></div>;
}
