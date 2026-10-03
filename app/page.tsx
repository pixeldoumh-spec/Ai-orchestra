"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";

type Task = any;
type Agent = any;
type Connector = any;
type Approval = { id: string; step_id: string; status: string; reason: string; action_type: string; connector_request_id?: string | null };

export default function Home() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);\n  const [networkAgents, setNetworkAgents] = useState<any[]>([]);
  const [org, setOrg] = useState<any>(null);
  const [goal, setGoal] = useState("Prepare a concise weekly business report");
  const [task, setTask] = useState<Task>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [workspaceName, setWorkspaceName] = useState("My Workspace");

  async function loadConnectors() {
    const res = await fetch("/api/connectors");
    if (!res.ok) return;
    const data = await res.json();
    setConnectors(data.connectors ?? []);
  }

  async function loadNetwork() { const res = await fetch("/api/network/agents"); if (!res.ok) return; const data = await res.json(); setNetworkAgents(data.agents ?? []); }\n\n  async function loadAgents() {
    const res = await fetch("/api/agents");
    if (!res.ok) {
      if (res.status === 401) setMessage("Sign in to use the control plane.");
      return;
    }
    const data = await res.json();
    setOrg(data.organization);
    setAgents(data.agents ?? []);
    await Promise.all([loadConnectors(), loadNetwork()]);
  }

  useEffect(() => { void loadAgents(); }, []);

  useEffect(() => {
    if (!task?.id || ["verified", "failed", "cancelled"].includes(task.status)) return;
    const handle = window.setInterval(async () => {
      const res = await fetch(`/api/tasks/${task.id}`);
      if (res.ok) setTask((await res.json()).task);
    }, 1200);
    return () => window.clearInterval(handle);
  }, [task?.id, task?.status]);

  async function createWorkspace() {
    setMessage("Creating workspace…");
    const res = await fetch("/api/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: workspaceName }),
    });
    const body = await res.json();
    if (!res.ok) return setMessage(body.error ?? "Workspace creation failed");
    await loadAgents();
    setMessage("");
  }

  async function run() {
    setLoading(true);
    setMessage("");
    const key = crypto.randomUUID();
    const createRes = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ goal, maxCostCents: 500 }),
    });
    const createBody = await createRes.json();
    if (!createRes.ok) {
      setMessage(createBody.error ?? "Task creation failed");
      setLoading(false);
      return;
    }
    setTask(createBody.task);
    const startRes = await fetch(`/api/tasks/${createBody.task.id}/start`, { method: "POST" });
    const startBody = await startRes.json();
    if (startBody.task) setTask(startBody.task);
    setLoading(false);
  }

  const health = useMemo(
    () => ({ healthy: agents.filter((a) => a.status === "healthy").length, total: agents.length }),
    [agents],
  );
  const connectorHealth = useMemo(
    () => ({
      active: connectors.filter((connector) => connector.status === "active").length,
      open: connectors.filter((connector) => connector.circuitState === "open").length,
      total: connectors.length,
    }),
    [connectors],
  );

  return <main className="shell">
    <header className="topbar">
      <div>
        <div className="eyebrow">AGENT CONTROL PLANE · V5</div>
        <h1>Orchestrator</h1>
      </div>
      <div className="topMeta">
        <span>{org?.name ?? "No workspace"}</span>
        <span>{health.healthy}/{health.total} agents healthy</span>
        <span>{connectorHealth.active}/{connectorHealth.total} connectors active</span><span>{networkAgents.length} network agents</span>
        <a href="/auth/sign-in">Account</a>
      </div>
    </header>

    <section className="hero card">
      <div>
        <div className="pill">AGENT NETWORK</div>
        <h2>Intent → plan → parallel agents → signed connectors → verification.</h2>
        <p className="muted">
          V4 adds per-agent identity, encrypted connector credentials, least-privilege bindings,
          signed expiring requests, provenance, circuit breakers and bounded fallback routing.
        </p>
      </div>
      <div className="healthGrid">
        <Metric label="Agents" value={String(health.total)} />
        <Metric label="Planner" value="DAG + validator" />
        <Metric label="Connectors" value={String(connectorHealth.total)} />
        <Metric label="Circuit" value={connectorHealth.open ? `${connectorHealth.open} open` : "closed"} /><Metric label="Network" value={String(networkAgents.length)} />
      </div>
    </section>

    <section className="card composer">
      {!org && !message.includes("Sign in") && <div className="workspacePrompt">
        <div>
          <b>Workspace required</b>
          <div className="muted small">Create a tenant workspace before submitting tasks.</div>
        </div>
        <div className="composerRow">
          <input value={workspaceName} onChange={(e: ChangeEvent<HTMLInputElement>) => setWorkspaceName(e.target.value)} />
          <button onClick={createWorkspace}>Create workspace</button>
        </div>
      </div>}
      <label htmlFor="goal">Give the orchestrator a goal</label>
      <div className="composerRow">
        <textarea id="goal" value={goal} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setGoal(e.target.value)} />
        <button onClick={run} disabled={loading || !org}>{loading ? "Executing…" : "Run goal"}</button>
      </div>
      <div className="muted small">
        A validated plan is persisted before execution. Independent ready steps execute together;
        retries, approvals and connector provenance are checkpointed.
      </div>
      {message && <div className="error">{message}</div>}
    </section>

    <section className="layout">
      <div className="card">
        <div className="sectionTitle">Agent registry</div>
        {agents.map((agent) => <div className="agentRow" key={agent.id}>
          <div className="agentDot" />
          <div>
            <b>{agent.name}</b>
            <div className="muted small">{agent.capabilities.join(" · ")}</div>
          </div>
          <div className="agentRight">
            <span>{agent.status}</span>
            <span>{agent.budget_cents ?? agent.budgetCents}¢</span>
          </div>
        </div>)}
      </div>

      <div className="card">
        <div className="sectionTitle">Execution</div>
        {task ? <TaskPanel task={task} /> : <div className="empty">Run a goal to create a durable V4 task.</div>}
      </div>
    </section>

    <ConnectorPanel connectors={connectors} />\n    <NetworkPanel agents={networkAgents} />
  </main>;
}

function TaskPanel({ task }: { task: Task }) {
  const approvals: Approval[] = task.approvals ?? [];
  const pendingApproval = approvals.find((approval) => approval.status === "pending");

  async function resolveApproval(decision: "approve" | "reject") {
    if (!pendingApproval) return;
    const res = await fetch(`/api/tasks/${task.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: pendingApproval.id, decision }),
    });
    if (!res.ok) return;
    window.location.reload();
  }

  return <div>
    <div className="taskHead">
      <div>
        <div className="muted small">TASK · REVISION {task.plan_revision ?? 1}</div>
        <b>{task.id}</b>
      </div>
      <span className={`status ${task.status}`}>{task.status}</span>
    </div>
    <div className="muted small planMeta">
      Planner: {task.planner_model ?? "deterministic fallback"} · Replans: {task.replan_count ?? 0}
    </div>
    <div className="stepList">
      {(task.steps ?? [])
        .filter((step: any) => step.plan_revision === (task.plan_revision ?? 1))
        .map((step: any, index: number) => <div className="step" key={step.id}>
          <div className="stepNum">{index + 1}</div>
          <div className="stepBody">
            <div className="stepTitle">
              <b>{step.agent_id}</b>
              <span className={`status mini ${step.kind}`}>{step.kind}</span>
            </div>
            <div className="muted small">{step.objective}</div>
            <span className={`status mini ${step.status}`}>{step.status}</span>
            {step.depends_on?.length > 0 && <div className="muted tiny">Depends on: {step.depends_on.length}</div>}
            {step.error && <div className="error small">{step.error}</div>}
          </div>
        </div>)}
    </div>
    {pendingApproval && <div className="approvalBox">
      <div>
        <b>Human approval required</b>
        <div className="muted small">{pendingApproval.reason}</div>
        {pendingApproval.connector_request_id && <div className="muted tiny">Signed connector request prepared.</div>}
      </div>
      <div className="approvalActions">
        <button onClick={() => resolveApproval("approve")}>Approve</button>
        <button className="secondary" onClick={() => resolveApproval("reject")}>Reject</button>
      </div>
    </div>}
    {task.final_result && <div className="resultBox">
      <div className="muted small">VERIFIED RESULT</div>
      <pre>{JSON.stringify(task.final_result, null, 2)}</pre>
    </div>}
    <div className="muted small">Spend: {task.spent_cost_cents ?? 0}¢ / {task.max_cost_cents ?? "—"}¢</div>
  </div>;
}

function ConnectorPanel({ connectors }: { connectors: Connector[] }) {
  return <section className="card infrastructure">
    <div className="sectionTitle">Connector infrastructure</div>
    {connectors.length === 0
      ? <div className="empty">
          No connectors registered. V4 keeps external side effects disabled until an explicit
          connector adapter is installed.
        </div>
      : connectors.map((connector) => <div className="agentRow" key={connector.id}>
          <div className="agentDot" />
          <div>
            <b>{connector.name}</b>
            <div className="muted small">
              {connector.authScheme} · v{connector.version} · fallback {connector.fallbackConnectorId ? "configured" : "none"}
            </div>
          </div>
          <div className="agentRight">
            <span>{connector.status}</span>
            <span>circuit {connector.circuitState}</span>
          </div>
        </div>)}
  </section>;
}

function NetworkPanel({ agents }: { agents: any[] }) {\n  return <section className="card infrastructure"><div className="sectionTitle">Agent network</div>\n    {agents.length===0 ? <div className="empty">No published or shared network agents are available yet.</div> : agents.map((item)=> <div className="agentRow" key={item.listing.id}><div className="agentDot" /><div><b>{item.listing.title}</b><div className="muted small">{item.organizationName} · {item.listing.capabilities.slice(0,5).join(" · ")}</div></div><div className="agentRight"><span>{item.access}</span><span>trust {item.reputation?.trustScore ?? 50}</span></div></div>)}\n    <div className="muted small">Discovery is metadata-only. Delegation requires an explicit provider share or provider acceptance, with negotiated capabilities and a bounded budget.</div>\n  </section>;\n}\n\nfunction Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><div className="muted small">{label}</div><b>{value}</b></div>;
}
