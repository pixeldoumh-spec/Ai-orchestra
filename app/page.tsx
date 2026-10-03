"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";

type Task = any;
type Agent = any;

type Approval = { id: string; step_id: string; status: string; reason: string; action_type: string };

export default function Home() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [org, setOrg] = useState<any>(null);
  const [goal, setGoal] = useState("Prepare a concise weekly business report");
  const [task, setTask] = useState<Task>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [workspaceName, setWorkspaceName] = useState("My Workspace");

  async function loadAgents() {
    const res = await fetch("/api/agents");
    if (!res.ok) { if (res.status === 401) setMessage("Sign in to use the control plane."); return; }
    const data = await res.json();
    setOrg(data.organization);
    setAgents(data.agents ?? []);
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
    const res = await fetch("/api/organizations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: workspaceName }) });
    const body = await res.json();
    if (!res.ok) return setMessage(body.error ?? "Workspace creation failed");
    await loadAgents();
    setMessage("");
  }

  async function run() {
    setLoading(true); setMessage("");
    const key = crypto.randomUUID();
    const createRes = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ goal, maxCostCents: 500 }) });
    const createBody = await createRes.json();
    if (!createRes.ok) { setMessage(createBody.error ?? "Task creation failed"); setLoading(false); return; }
    setTask(createBody.task);
    const startRes = await fetch(`/api/tasks/${createBody.task.id}/start`, { method: "POST" });
    const startBody = await startRes.json();
    if (startBody.task) setTask(startBody.task);
    setLoading(false);
  }

  const health = useMemo(() => ({ healthy: agents.filter((a) => a.status === "healthy").length, total: agents.length }), [agents]);

  return <main className="shell">
    <header className="topbar"><div><div className="eyebrow">AGENT CONTROL PLANE · V3</div><h1>Orchestrator</h1></div><div className="topMeta"><span>{org?.name ?? "No workspace"}</span><span>{health.healthy}/{health.total} agents healthy</span><a href="/auth/sign-in">Account</a></div></header>

    <section className="hero card"><div><div className="pill">INTELLIGENT ORCHESTRATION</div><h2>Intent → plan → parallel agents → tools → verification.</h2><p className="muted">V3 adds a validated dynamic DAG planner, true ready-step parallelism, structured tool requests, cumulative cost control and bounded recovery replanning.</p></div><div className="healthGrid"><Metric label="Agents" value={`${health.total}`} /><Metric label="Planner" value={"DAG + validator"} /><Metric label="Execution" value={"parallel"} /><Metric label="Policy" value={"enforced"} /></div></section>

    <section className="card composer">{!org && !message.includes("Sign in") && <div className="workspacePrompt"><div><b>Workspace required</b><div className="muted small">Create a tenant workspace before submitting tasks.</div></div><div className="composerRow"><input value={workspaceName} onChange={(e: ChangeEvent<HTMLInputElement>) => setWorkspaceName(e.target.value)} /><button onClick={createWorkspace}>Create workspace</button></div></div>}<label htmlFor="goal">Give the orchestrator a goal</label><div className="composerRow"><textarea id="goal" value={goal} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setGoal(e.target.value)} /><button onClick={run} disabled={loading || !org}>{loading ? "Executing…" : "Run goal"}</button></div><div className="muted small">A validated plan is persisted before execution. Independent ready steps execute together; retries and recovery are checkpointed.</div>{message && <div className="error">{message}</div>}</section>

    <section className="layout">
      <div className="card"><div className="sectionTitle">Agent registry</div>{agents.map((agent) => <div className="agentRow" key={agent.id}><div className="agentDot" /><div><b>{agent.name}</b><div className="muted small">{agent.capabilities.join(" · ")}</div></div><div className="agentRight"><span>{agent.status}</span><span>{agent.budget_cents ?? agent.budgetCents}¢</span></div></div>)}</div>
      <div className="card"><div className="sectionTitle">Execution</div>{task ? <TaskPanel task={task} /> : <div className="empty">Run a goal to create a durable V3 task.</div>}</div>
    </section>
  </main>;
}

function TaskPanel({ task }: { task: Task }) {
  const approvals: Approval[] = task.approvals ?? [];
  const pendingApproval = approvals.find((approval) => approval.status === "pending");

  async function resolveApproval(decision: "approve" | "reject") {
    const res = await fetch(`/api/tasks/${task.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId: pendingApproval?.id, decision }) });
    if (!res.ok) return;
    window.location.reload();
  }

  return <div>
    <div className="taskHead"><div><div className="muted small">TASK · REVISION {task.plan_revision ?? 1}</div><b>{task.id}</b></div><span className={`status ${task.status}`}>{task.status}</span></div>
    <div className="muted small planMeta">Planner: {task.planner_model ?? "deterministic fallback"} · Replans: {task.replan_count ?? 0}</div>
    <div className="stepList">{(task.steps ?? []).filter((step: any) => step.plan_revision === (task.plan_revision ?? 1)).map((step: any, index: number) => <div className="step" key={step.id}><div className="stepNum">{index + 1}</div><div className="stepBody"><div className="stepTitle"><b>{step.agent_id}</b><span className={`status mini ${step.kind}`}>{step.kind}</span></div><div className="muted small">{step.objective}</div><span className={`status mini ${step.status}`}>{step.status}</span>{step.depends_on?.length > 0 && <div className="muted tiny">Depends on: {step.depends_on.length}</div>}{step.error && <div className="error small">{step.error}</div>}</div></div>)}</div>
    {pendingApproval && <div className="approvalBox"><div><b>Human approval required</b><div className="muted small">{pendingApproval.reason}</div></div><div className="approvalActions"><button onClick={() => resolveApproval("approve")}>Approve</button><button className="secondary" onClick={() => resolveApproval("reject")}>Reject</button></div></div>}
    {task.final_result && <div className="resultBox"><div className="muted small">VERIFIED RESULT</div><pre>{JSON.stringify(task.final_result, null, 2)}</pre></div>}
    <div className="muted small">Spend: {task.spent_cost_cents ?? 0}¢ / {task.max_cost_cents ?? "—"}¢</div>
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><div className="muted small">{label}</div><b>{value}</b></div>; }