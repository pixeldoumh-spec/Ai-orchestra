"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { MobileWorkspaceNav } from "@/components/MobileWorkspaceNav";

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

type IconName =
  | "home"
  | "runs"
  | "knowledge"
  | "network"
  | "marketplace"
  | "billing"
  | "enterprise"
  | "settings"
  | "plus"
  | "arrow"
  | "spark"
  | "check"
  | "shield"
  | "chevron"
  | "user";

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  const paths: Record<IconName, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9" /><path d="M9 20v-6h6v6" /></>,
    runs: <><path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></>,
    knowledge: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 5.5v15" /><path d="M8 8h8" /><path d="M8 11h6" /></>,
    network: <><circle cx="6" cy="7" r="2.5" /><circle cx="18" cy="17" r="2.5" /><circle cx="18" cy="7" r="2.5" /><path d="M8.2 8.1 15.8 15.9" /><path d="M8.5 7h7" /></>,
    marketplace: <><path d="M4 9h16l-1-5H5z" /><path d="M6 9v10h12V9" /><path d="M9 19v-6h6v6" /></>,
    billing: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /><path d="M7 15h4" /></>,
    enterprise: <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 7h2" /><path d="M13 7h2" /><path d="M9 11h2" /><path d="M13 11h2" /><path d="M9 15h2" /><path d="M13 15h2" /></>,
    settings: <><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="m19.4 15 .9 1.6-1.8 1.8-1.6-.9a7.9 7.9 0 0 1-1.9.8l-.4 1.8h-2.6l-.4-1.8a7.9 7.9 0 0 1-1.9-.8l-1.6.9-1.8-1.8.9-1.6a7.9 7.9 0 0 1-.8-1.9L4.6 12v-2.6l1.8-.4a7.9 7.9 0 0 1 .8-1.9l-.9-1.6 1.8-1.8 1.6.9a7.9 7.9 0 0 1 1.9-.8L12 2h2.6l.4 1.8a7.9 7.9 0 0 1 1.9.8l1.6-.9 1.8 1.8-.9 1.6a7.9 7.9 0 0 1 .8 1.9l1.8.4V12l-1.8.4a7.9 7.9 0 0 1-.8 1.9Z" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    arrow: <><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></>,
    spark: <><path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6Z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7Z" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
    shield: <><path d="M12 3 19 6v5c0 4.7-2.9 8.1-7 10-4.1-1.9-7-5.3-7-10V6z" /><path d="m9 12 2 2 4-4" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.2 3.1-5 7-5s6.2 1.8 7 5" /></>,
  };

  return <svg {...common}>{paths[name]}</svg>;
}

const navItems = [
  { href: "/", label: "Home", icon: "home" as IconName },
  { href: "/runs", label: "Runs", icon: "runs" as IconName },
  { href: "/network", label: "Agent network", icon: "network" as IconName },
  { href: "/knowledge", label: "Knowledge", icon: "knowledge" as IconName },
  { href: "/marketplace", label: "Marketplace", icon: "marketplace" as IconName },
  { href: "/connectors", label: "Connectors", icon: "marketplace" as IconName },
  { href: "/billing", label: "Billing", icon: "billing" as IconName },
  { href: "/enterprise", label: "Workspace", icon: "enterprise" as IconName },
];

export default function Home() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [org, setOrg] = useState<any>(null);
  const [goal, setGoal] = useState("Prepare a concise weekly business report");
  const [task, setTask] = useState<Task>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [workspaceName, setWorkspaceName] = useState("My Workspace");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [recentTasks, setRecentTasks] = useState<Task[]>([]);

  async function loadConnectors() {
    const r = await fetch("/api/connectors");
    if (r.ok) setConnectors((await r.json()).connectors ?? []);
  }

  async function loadAgents() {
    const r = await fetch("/api/agents");
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) setMessage("Sign in to use the control plane.");
      else setMessage(d.error ?? ("Control plane unavailable (HTTP " + r.status + ")"));
      return;
    }

    const d = await r.json();
    setOrg(d.organization);
    setAgents(d.agents ?? []);

    const historyResponse = await fetch("/api/tasks?limit=6");
    if (historyResponse.ok) setRecentTasks((await historyResponse.json()).tasks ?? []);

    const teamResponse = await fetch("/api/enterprise/teams");
    if (teamResponse.ok) setTeams((await teamResponse.json()).teams ?? []);

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
        // Keep stream alive.
      }
    };

    source.addEventListener("execution", onExecution);
    source.onerror = () => {
      // EventSource retries using Last-Event-ID.
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
    const trimmed = goal.trim();

    if (!trimmed) {
      setMessage("Tell Orchestra what outcome you want.");
      return;
    }

    setLoading(true);
    setMessage("");

    const create = await fetch("/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        goal: trimmed,
        maxCostCents: 500,
        teamId: selectedTeamId || null,
      }),
    });

    const b = await create.json();

    if (!create.ok) {
      setMessage(b.error ?? "Task creation failed");
      setLoading(false);
      return;
    }

    setTask(b.task);

    const start = await fetch("/api/tasks/" + b.task.id + "/start", {
      method: "POST",
    });

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
      total: connectors.length,
    }),
    [connectors],
  );

  const isWorkspaceMissing = !org && !message.includes("Sign in");

  return (
    <div className="orchestraApp">
      <aside className="orchestraRail">
        <a className="orchestraBrand" href="/">
          <span className="brandMark">A</span>
          <span>AI Orchestra</span>
        </a>

        <button className="newTaskButton" type="button" onClick={() => {
          setTask(null);
          setGoal("");
          setMessage("");
          document.getElementById("goal-input")?.focus();
        }}>
          <Icon name="plus" size={16} />
          <span>New task</span>
        </button>

        <nav className="orchestraNav" aria-label="Primary navigation">
          <div className="navGroup">
            <div className="navLabel">Workspace</div>
            {navItems.slice(0, 6).map((item) => (
              <a className={"navItem " + (item.href === "/" ? "active" : "")} href={item.href} key={item.href}>
                <Icon name={item.icon} size={15} />
                <span>{item.label}</span>
              </a>
            ))}
          </div>

          <div className="navGroup">
            <div className="navLabel">Manage</div>
            {navItems.slice(6).map((item) => (
              <a className="navItem" href={item.href} key={item.href}>
                <Icon name={item.icon} size={15} />
                <span>{item.label}</span>
              </a>
            ))}
            <a className="navItem" href="/auth/sign-in">
              <Icon name="user" size={15} />
              <span>Account</span>
            </a>
          </div>
        </nav>

        <div className="railFooter">
          <div className="railStatus">
            <span className="statusDot" />
            <div>
              <strong>Orchestra ready</strong>
              <span>{health.healthy}/{health.total} agents healthy</span>
            </div>
          </div>
          <a className="railSettings" href="/enterprise">
            <Icon name="settings" size={15} />
            <span>Settings</span>
          </a>
        </div>
      </aside>

      <section className="orchestraMain">
        <header className="orchestraHeader">
          <div className="workspaceTitle">
            <span>{org?.name ?? "My Workspace"}</span>
            <span className="headerChevron"><Icon name="chevron" size={13} /></span>
          </div>

          <div className="headerActions">
            <span className="healthPill"><span className="statusDot" /> Healthy</span>
            <a className="avatarButton" href="/auth/sign-in" aria-label="Account">
              <Icon name="user" size={15} />
            </a>
          </div>
        </header>

        <main className="orchestraCanvas">
          <div className="orchestraContent">
            {isWorkspaceMissing && (
              <section className="inlineNotice">
                <div>
                  <div className="noticeTitle">Set up your workspace</div>
                  <div className="noticeCopy">Your orchestration environment only takes a moment to initialize.</div>
                </div>
                <div className="workspaceCreate">
                  <input
                    aria-label="Workspace name"
                    value={workspaceName}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setWorkspaceName(e.target.value)}
                    placeholder="Workspace name"
                  />
                  <button type="button" onClick={createWorkspace}>Create</button>
                </div>
              </section>
            )}

            <section className="welcomeArea">
              <div className="welcomeKicker"><Icon name="spark" size={15} /> Agentic workspace</div>
              <h1>What would you like to get done?</h1>
              <p>
                Give Orchestra the outcome. It can research, reason, delegate to specialists,
                use approved tools, and verify the result—while keeping the infrastructure out of your way.
              </p>
            </section>

            <section className="suggestionRow" aria-label="Suggested tasks">
              <SuggestionCard
                title="Research a topic"
                description="Sources → analysis → verified brief"
                onClick={() => setGoal("Research this market and summarize the strongest opportunities.")}
              />
              <SuggestionCard
                title="Create a report"
                description="Collect → analyze → write → verify"
                onClick={() => setGoal("Prepare a concise weekly business report.")}
              />
              <SuggestionCard
                title="Explore knowledge"
                description="Workspace memory + documents"
                onClick={() => setGoal("Review our workspace knowledge and identify what changed this week.")}
              />
            </section>

            <section className="composerWrap">
              <div className="composerBox">
                <textarea
                  id="goal-input"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="Ask Orchestra anything…"
                  aria-label="Goal"
                />

                <div className="composerBottom">
                  <div className="composerTools">
                    <button className={"composerTool " + (showCapabilities ? "selected" : "")} type="button" onClick={() => setShowCapabilities((v) => !v)}>
                      <Icon name="plus" size={14} /> Capabilities
                    </button>
                    <span className="composerHint">Research · knowledge · delegation · verification</span>
                  </div>

                  <button className="runButton" type="button" disabled={loading || isWorkspaceMissing} onClick={run}>
                    {loading ? "Running…" : "Run with Orchestra"}
                    <Icon name="arrow" size={14} />
                  </button>
                </div>

                {showCapabilities && (
                  <div className="capabilityPopover">
                    <div><Icon name="check" size={14} /><span><strong>Research</strong><small>Web and workspace sources</small></span></div>
                    <div><Icon name="check" size={14} /><span><strong>Specialists</strong><small>Research, analysis, writer and verifier agents</small></span></div>
                    <div><Icon name="check" size={14} /><span><strong>Governance</strong><small>Tenant policy, budgets and approval gates</small></span></div>
                    <div><Icon name="shield" size={14} /><span><strong>Safety</strong><small>High-impact external actions can require approval</small></span></div>
                  </div>
                )}
              </div>
              <div className="composerSafety">
                <Icon name="shield" size={12} />
                <span>You stay in control. External side effects remain policy-gated.</span>
              </div>
            </section>

            {message && <div className="friendlyMessage" role="status">{message}</div>}

            {task ? (
              <TaskPanel task={task} teams={teams} />
            ) : (
              <section className="recentRuns">
                <div className="recentRunsHeader">
                  <div><div className="sectionTitle">Recent runs</div><div className="muted tiny">Continue where you left off.</div></div>
                  <a href="/runs" className="smallLink">View all →</a>
                </div>
                {recentTasks.length===0 ? (
                  <div className="emptyState compact"><div className="emptyIcon"><Icon name="spark" size={17} /></div><strong>Your next run will appear here</strong><span>Orchestra will keep the run addressable after you leave this page.</span></div>
                ) : recentTasks.map((t:any)=>(
                  <a key={t.id} href={"/runs?task=" + encodeURIComponent(t.id)} className="recentRunItem">
                    <div><strong>{t.goal}</strong><span>{t.id} · {formatHomeStatus(t.status)}</span></div>
                    <span>{t.spent_cost_cents??0}¢</span>
                  </a>
                ))}
              </section>
            )}

            <footer className="orchestraFooter">
              <span>{ch.active}/{ch.total} connectors active</span>
              <span>•</span>
              <span>Background execution enabled</span>
              <span>•</span>
              <span>SSE state replay</span>
            </footer>
          </div>
        </main>
      </section>
      <MobileWorkspaceNav />
    </div>
  );
}

function SuggestionCard({
  title,
  description,
  onClick,
}: {
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button className="suggestionCard" type="button" onClick={onClick}>
      <span className="suggestionTitle">{title}</span>
      <span className="suggestionDescription">{description}</span>
      <span className="suggestionArrow"><Icon name="arrow" size={13} /></span>
    </button>
  );
}

function TaskPanel({ task, teams }: { task: Task; teams: any[] }) {
  const approvals: Approval[] = task.approvals ?? [];
  const pending = approvals.find((a) => a.status === "pending");
  const [evidence, setEvidence] = useState<any[]>([]);
  const [comments, setComments] = useState<any[]>([]);
  const [comment, setComment] = useState("");

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

  useEffect(() => {
    let live = true;

    void fetch("/api/tasks/" + encodeURIComponent(task.id) + "/comments")
      .then(async (r) => (r.ok ? r.json() : { comments: [] }))
      .then((d) => {
        if (live) setComments(d.comments ?? []);
      })
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [task.id, task.events?.length]);

  async function addComment() {
    if (!comment.trim()) return;

    const r = await fetch("/api/tasks/" + task.id + "/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: comment }),
    });

    const b = await r.json();

    if (r.ok) {
      setComments((old) => [...old, b.comment]);
      setComment("");
    }
  }

  async function assignTeam(teamId: string) {
    const r = await fetch("/api/tasks/" + task.id + "/team", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId: teamId || null }),
    });

    if (!r.ok) return;

    const b = await r.json();
    if (b.task) window.location.reload();
  }

  async function resolve(decision: "approve" | "reject") {
    if (!pending) return;

    const r = await fetch("/api/tasks/" + task.id + "/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: pending.id, decision }),
    });

    if (r.ok) window.location.reload();
  }

  const currentRevision = task.plan_revision ?? 1;
  const steps = (task.steps ?? []).filter((s: any) => s.plan_revision === currentRevision);

  return (
    <section className="runPanel" aria-live="polite">
      <div className="runPanelHeader">
        <div>
          <div className="runEyebrow">ACTIVE RUN</div>
          <h2>{task.goal ?? "Orchestration task"}</h2>
          <div className="runMeta">Task {task.id} · Region {task.execution_region ?? "policy assigned"} · Revision {currentRevision}</div>
        </div>
        <span className={"runState " + task.status}>
          <span className="stateDot" />
          {formatStatus(task.status)}
        </span>
      </div>

      <div className="executionTimeline">
        {steps.map((step: any, i: number) => (
          <div className="executionStep" key={step.id}>
            <div className={"stepMarker " + step.status}>{step.status === "verified" || step.status === "succeeded" ? <Icon name="check" size={13} /> : i + 1}</div>
            <div className="stepDetails">
              <div className="stepLine">
                <strong>{prettyStepLabel(step)}</strong>
                <span>{formatStatus(step.status)}</span>
              </div>
              <div className="stepObjective">{step.objective}</div>
              <div className="stepTrack"><span style={{ width: stepWidth(step.status) }} /></div>
            </div>
          </div>
        ))}
      </div>

      {pending && (
        <div className="approvalNotice">
          <div className="approvalIcon"><Icon name="shield" size={16} /></div>
          <div className="approvalCopy">
            <strong>This action needs your approval</strong>
            <span>{pending.reason}</span>
          </div>
          <div className="approvalActions">
            <button type="button" onClick={() => resolve("approve")}>Approve</button>
            <button type="button" className="quietButton" onClick={() => resolve("reject")}>Reject</button>
          </div>
        </div>
      )}

      {task.final_result && (
        <div className="finalResult">
          <div className="resultHeader">
            <span><Icon name="check" size={14} /> Verified result</span>
            <span>Complete</span>
          </div>
          <pre>{JSON.stringify(task.final_result, null, 2)}</pre>
        </div>
      )}

      {evidence.length > 0 && (
        <details className="detailsBlock" open>
          <summary>Evidence · {evidence.length}</summary>
          <div className="detailsContent">
            {evidence.slice(0, 12).map((e: any) => (
              <div className="evidenceItem" key={e.id}>
                <div className="evidenceTitle">
                  <strong>{e.source_title ?? e.source_type}</strong>
                  {e.confidence != null && <span>{Math.round(Number(e.confidence) * 100)}% confidence</span>}
                </div>
                {e.claim && <p>{e.claim}</p>}
                {e.excerpt && <p className="evidenceExcerpt">{e.excerpt}</p>}
                {e.source_url && <a href={e.source_url} target="_blank" rel="noreferrer">Open source</a>}
              </div>
            ))}
          </div>
        </details>
      )}

      {(teams.length > 0 || comments.length > 0) && (
        <details className="detailsBlock">
          <summary>Collaboration</summary>
          <div className="detailsContent">
            {teams.length > 0 && (
              <div className="collabRow">
                <label htmlFor="task-team">Team</label>
                <select id="task-team" value={task.team_id ?? ""} onChange={(e) => assignTeam(e.target.value)}>
                  <option value="">No team assignment</option>
                  {teams.map((team: any) => <option key={team.id} value={team.id}>{team.name}</option>)}
                </select>
              </div>
            )}

            {comments.slice(-10).map((item: any) => (
              <div className="commentItem" key={item.id}>
                <strong>{String(item.author_id).slice(0, 8)}…</strong>
                <span>{item.body}</span>
                <time>{item.created_at}</time>
              </div>
            ))}

            <div className="commentComposer">
              <input
                placeholder="Add a note to this run…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addComment();
                }}
              />
              <button type="button" disabled={!comment.trim()} onClick={addComment}>Add</button>
            </div>
          </div>
        </details>
      )}

      <div className="runFooter">
        <span>Spend {(task.spent_cost_cents ?? 0)}¢ / {(task.max_cost_cents ?? 0)}¢</span>
        <span>{steps.length} planned steps</span>
        <span>{executionLabel(task.status)}</span>
      </div>
    </section>
  );
}

function prettyStepLabel(step:any){
  const planId = typeof step?.checkpoint?.planStepId === "string" ? step.checkpoint.planStepId : "";
  if(planId === "research_primary") return "Research · primary";
  if(planId === "research_secondary") return "Research · complementary";
  return prettyAgent(step?.agent_id);
}

function executionLabel(status:string){
  switch(String(status??"queued")){
    case "running": return "Background worker active";
    case "awaiting_approval": return "Waiting for approval";
    case "verified": return "Execution complete";
    case "failed": return "Execution failed";
    case "cancelled": return "Execution cancelled";
    default: return "Queued for background execution";
  }
}

function prettyAgent(value: string) {
  const raw = String(value ?? "").replace(/[_-]+/g, " ").trim();
  if (!raw) return "Specialist";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatStatus(value: string) {
  return String(value ?? "pending").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function stepWidth(status: string) {
  if (["verified", "succeeded", "completed"].includes(status)) return "100%";
  if (["running", "executing", "working"].includes(status)) return "58%";
  if (["failed", "cancelled", "rejected"].includes(status)) return "100%";
  return "8%";
}

function formatHomeStatus(value: string){ return String(value ?? "pending").replace(/[_-]+/g," ").replace(/\b\w/g,(c)=>c.toUpperCase()); }
