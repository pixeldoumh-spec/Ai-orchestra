"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";

type Task = any;
type Agent = any;
type Connector = any;
type Approval = {
  id: string;
  step_id: string;
  status: string;
  reason: string;
  action_type: string;
  connector_request_id?: string | null;
};

export default function Home() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [org, setOrg] = useState<any>(null);
  const [goal, setGoal] = useState("Prepare a concise weekly business report");
  const [task, setTask] = useState<Task>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [workspaceName, setWorkspaceName] = useState("My Workspace");

  async function loadConnectors() {
    const r = await fetch("/api/connectors");
    if (r.ok) setConnectors((await r.json()).connectors ?? []);
  }

  async function loadAgents() {
    const r = await fetch("/api/agents");
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) setMessage("Sign in to use the control plane.");
      else setMessage(d.error ?? `Control plane unavailable (HTTP ${r.status})`);
      return;
    }
    const d = await r.json();
    setOrg(d.organization);
    setAgents(d.agents ?? []);
    await loadConnectors();
  }

  useEffect(() => {
    void loadAgents();
  }, []);

  useEffect(() => {
    if (!task?.id || ["verified", "failed", "cancelled"].includes(task.status)) return;
    const source = new EventSource("/api/tasks/" + task.id + "/stream");
    const onExecution = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "snapshot" && payload.task) {
          setTask(payload.task);
          if (["verified", "failed", "cancelled"].includes(payload.task.status)) source.close();
        }
      } catch {
        // Keep the stream alive; the next snapshot will repair client state.
      }
    };
    source.addEventListener("execution", onExecution);
    source.onerror = () => {
      // EventSource automatically retries with Last-Event-ID.
    };
    return () => source.close();
  }, [task?.id]);

  async function createWorkspace() {
    setMessage("Creating workspace…");
    const r = await fetch("/api/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: workspaceName }),
    });
    const b = await r.json();
    if (!r.ok) return setMessage(b.error ?? "Workspace creation failed");
    await loadAgents();
    setMessage("");
  }

  async function run() {
    setLoading(true);
    setMessage("");
    const create = await fetch("/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ goal, maxCostCents: 500 }),
    });
    const b = await create.json();
    if (!create.ok) {
      setMessage(b.error ?? "Task creation failed");
      setLoading(false);
      return;
    }
    setTask(b.task);
    const start = await fetch("/api/tasks/" + b.task.id + "/start", { method: "POST" });
    const sb = await start.json();
    if (!start.ok) setMessage(sb.error ?? "Background dispatch failed");
    if (sb.task) setTask(sb.task);
    setLoading(false);
  }

  const health = useMemo(
    () => ({
      healthy: agents.filter((a) => a.status === "healthy").length,
      total: agents.length,
    }),
    [agents],
  );
  const ch = useMemo(
    () => ({
      active: connectors.filter((c) => c.status === "active").length,
      open: connectors.filter((c) => c.circuitState === "open").length,
      total: connectors.length,
    }),
    [connectors],
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">AGENT CONTROL PLANE · V6.6</div>
          <h1>Orchestrator</h1>
        </div>
        <div className="topMeta">
          <span>{org?.name ?? "No workspace"}</span>
          <span>{health.healthy}/{health.total} agents healthy</span>
          <span>{ch.active}/{ch.total} connectors active</span>
          <a href="/network">Agent Network</a>
          <a href="/knowledge">Knowledge</a>
          <a href="/enterprise">Operations</a>
          <a href="/auth/sign-in">Account</a>
        </div>
      </header>

      <section className="hero card">
        <div>
          <div className="pill">PRODUCTION OPERATIONS · V6.6</div>
          <h2>Intent → queue → parallel agents → signed tools → verified execution.</h2>
          <p className="muted">
            V6.6 keeps execution durable after the browser disconnects, streams state back to the UI,
            records model latency and resource usage, and falls back to a secondary model when the
            primary provider becomes unavailable.
          </p>
        </div>
        <div className="healthGrid">
          <Metric label="Agents" value={String(health.total)} />
          <Metric label="Execution" value="Background queue" />
          <Metric label="Stream" value="SSE + replay" />
          <Metric label="Fallback" value="GLM-4.7 Flash" />
        </div>
      </section>

      <section className="card composer">
        {!org && !message.includes("Sign in") && (
          <div className="workspacePrompt">
            <div>
              <b>Workspace required</b>
              <div className="muted small">Create a tenant workspace before submitting tasks.</div>
            </div>
            <div className="composerRow">
              <input
                value={workspaceName}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setWorkspaceName(e.target.value)}
              />
              <button onClick={createWorkspace}>Create workspace</button>
            </div>
          </div>
        )}
        <label htmlFor="goal">Give the orchestrator a goal</label>
        <div className="composerRow">
          <textarea
            id="goal"
            value={goal}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setGoal(e.target.value)}
          />
          <button onClick={run} disabled={loading || !org}>
            {loading ? "Dispatching…" : "Run goal"}
          </button>
        </div>
        <div className="muted small">
          Tasks are admitted by tenant policy, then handed to the production queue. Closing this page
          does not cancel execution.
        </div>
        {message && <div className="error">{message}</div>}
      </section>

      <section className="layout">
        <div className="card">
          <div className="sectionTitle">Specialized agent registry</div>
          {agents.map((a) => (
            <div className="agentRow" key={a.id}>
              <div className="agentDot" />
              <div>
                <b>{a.name}</b>
                <div className="muted small">{a.capabilities.join(" · ")}</div>
              </div>
              <div className="agentRight">
                <span>{a.status}</span>
                <span>{a.budget_cents ?? a.budgetCents}¢</span>
              </div>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="sectionTitle">Live execution</div>
          {task ? <TaskPanel task={task} /> : <div className="empty">Run a goal to create a durable V6.6 task.</div>}
        </div>
      </section>

      <ConnectorPanel connectors={connectors} />
    </main>
  );
}

function TaskPanel({ task }: { task: Task }) {
  const approvals: Approval[] = task.approvals ?? [];
  const pending = approvals.find((a) => a.status === "pending");
  const [evidence, setEvidence] = useState<any[]>([]);

  useEffect(() => {
    let live = true;
    void fetch("/api/evidence?taskId=" + encodeURIComponent(task.id))
      .then(async (r) => (r.ok ? r.json() : { evidence: [] }))
      .then((d) => {
        if (live) setEvidence(d.evidence ?? []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [task.id]);

  async function resolve(decision: "approve" | "reject") {
    if (!pending) return;
    const r = await fetch("/api/tasks/" + task.id + "/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: pending.id, decision }),
    });
    if (r.ok) window.location.reload();
  }

  return (
    <div>
      <div className="taskHead">
        <div>
          <div className="muted small">
            TASK · REGION {task.execution_region ?? "assigned by policy"} · REVISION {task.plan_revision ?? 1}
          </div>
          <b>{task.id}</b>
        </div>
        <span className={"status " + task.status}>{task.status}</span>
      </div>

      <div className="stepList">
        {(task.steps ?? [])
          .filter((s: any) => s.plan_revision === (task.plan_revision ?? 1))
          .map((s: any, i: number) => (
            <div className="step" key={s.id}>
              <div className="stepNum">{i + 1}</div>
              <div className="stepBody">
                <b>{s.agent_id}</b>
                <div className="muted small">{s.objective}</div>
                <span className={"status mini " + s.status}>{s.status}</span>
              </div>
            </div>
          ))}
      </div>

      {evidence.length > 0 && (
        <div className="resultBox">
          <div className="muted small">EVIDENCE · {evidence.length}</div>
          {evidence.slice(0, 12).map((e: any) => (
            <div key={e.id} style={{ marginTop: 10 }}>
              <div>
                <b>{e.source_title ?? e.source_type}</b>
                {e.confidence != null && (
                  <span className="muted small" style={{ marginLeft: 8 }}>
                    confidence {Math.round(Number(e.confidence) * 100)}%
                  </span>
                )}
              </div>
              {e.claim && <div className="muted small">Claim: {e.claim}</div>}
              {e.source_url && (
                <div className="muted small">
                  <a href={e.source_url} target="_blank" rel="noreferrer">{e.source_url}</a>
                </div>
              )}
              {e.excerpt && <div className="muted small">{e.excerpt}</div>}
            </div>
          ))}
        </div>
      )}

      {pending && (
        <div className="approvalBox">
          <div>
            <b>Human approval required</b>
            <div className="muted small">{pending.reason}</div>
          </div>
          <div className="approvalActions">
            <button onClick={() => resolve("approve")}>Approve</button>
            <button className="secondary" onClick={() => resolve("reject")}>Reject</button>
          </div>
        </div>
      )}

      {task.final_result && (
        <div className="resultBox">
          <div className="muted small">VERIFIED RESULT</div>
          <pre>{JSON.stringify(task.final_result, null, 2)}</pre>
        </div>
      )}

      <div className="muted small">
        Spend: {task.spent_cost_cents ?? 0}¢ / {task.max_cost_cents ?? "—"}¢
      </div>
    </div>
  );
}

function ConnectorPanel({ connectors }: { connectors: Connector[] }) {
  return (
    <section className="card infrastructure">
      <div className="sectionTitle">Connector infrastructure</div>
      {connectors.length === 0 ? (
        <div className="empty">
          No connectors registered. External side effects remain disabled until an explicit connector adapter is installed.
        </div>
      ) : (
        connectors.map((c) => (
          <div className="agentRow" key={c.id}>
            <div className="agentDot" />
            <div>
              <b>{c.name}</b>
              <div className="muted small">
                {c.authScheme} · v{c.version} · fallback {c.fallbackConnectorId ? "configured" : "none"}
              </div>
            </div>
            <div className="agentRight">
              <span>{c.status}</span>
              <span>circuit {c.circuitState}</span>
            </div>
          </div>
        ))
      )}
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
