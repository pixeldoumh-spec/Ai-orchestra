"use client";

import { useMemo, useState } from "react";

type EventItem = {
  id?: string | number;
  event_type?: string;
  payload?: any;
  created_at?: string;
};

export function ExecutionWorkspace({
  task,
  events = [],
  title = "Execution trace",
  subtitle = "Durable orchestration session",
}: {
  task: any;
  events?: EventItem[];
  title?: string;
  subtitle?: string;
}) {
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  const currentRevision = Number(task?.plan_revision ?? 1);
  const steps = useMemo(() => {
    const current = (task?.steps ?? []).filter((step: any) => Number(step.plan_revision ?? 1) === currentRevision);
    return orderStepsByDependencies(current);
  }, [task?.steps, currentRevision]);

  const verifiedCount = steps.filter((step: any) => ["verified", "succeeded", "completed"].includes(String(step.status))).length;
  const activeStep = steps.find((step: any) => ["running", "executing", "working"].includes(String(step.status))) ?? null;
  const waitingStep = steps.find((step: any) => String(step.status) === "awaiting_approval") ?? null;

  const recentEvents = useMemo(() => events
    .slice()
    .sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0))
    .slice(-8)
    .map(describeEvent)
    .filter((item): item is NonNullable<ReturnType<typeof describeEvent>> => item !== null)
    .reverse(), [events]);

  const latestModelEvent = [...events]
    .reverse()
    .find((event) => ["model.selected", "model.completed", "model.fallback"].includes(String(event.event_type)));

  const latestModel = latestModelEvent?.payload?.model
    ?? latestModelEvent?.payload?.toModel
    ?? activeStep?.checkpoint?.model
    ?? null;

  const status = String(task?.status ?? "queued");
  const live = ["queued", "running", "awaiting_approval"].includes(status);
  const progressLabel = steps.length > 0 ? verifiedCount + "/" + steps.length + " verified" : "Plan ready";

  return (
    <section className="executionBay executionWorkspace" aria-label="AI Orchestra execution workspace">
      <header className="executionBayTop executionWorkspaceHeader">
        <div className="executionBayTitle">
          <span className={"executionLiveDot " + (live ? "isLive" : "isDone")} />
          <div>
            <strong>{title}</strong>
            <span>{subtitle}</span>
          </div>
        </div>

        <div className="executionStats" aria-label="Execution summary">
          <span>{progressLabel}</span>
          <span>{activeStep ? "Active · " + prettyAgent(activeStep.agent_id) : waitingStep ? "Approval required" : formatStatus(status)}</span>
          {latestModel && <span className="executionModelPill">{shortModel(String(latestModel))}</span>}
        </div>
      </header>

      <div className="executionWorkspaceStrip">
        <div>
          <span className="executionStripLabel">Plan flow</span>
          <strong>{steps.length} stages</strong>
        </div>
        <div>
          <span className="executionStripLabel">Handoffs</span>
          <strong>{events.filter((event) => event.event_type === "model.handoff.received").length}</strong>
        </div>
        <div>
          <span className="executionStripLabel">Replans</span>
          <strong>{Number(task?.replan_count ?? 0)}</strong>
        </div>
        <div className="executionStripCurrent">
          <span className="executionStripLabel">Current focus</span>
          <strong>{activeStep ? prettyStepLabel(activeStep) : waitingStep ? "Awaiting approval" : executionFocus(status)}</strong>
        </div>
      </div>

      <div className="executionTimeline executionWorkspaceTimeline">
        {steps.length === 0 ? (
          <div className="executionEmpty">Waiting for the planner to produce executable stages.</div>
        ) : steps.map((step: any, index: number) => {
          const active = ["running", "executing", "working"].includes(String(step.status));
          const complete = ["verified", "succeeded", "completed"].includes(String(step.status));
          const selected = expandedStep === step.id;
          const upstreamCount = events
            .filter((event) => event.event_type === "model.handoff.received" && event.payload?.stepId === step.id)
            .reduce((sum, event) => sum + Number(event.payload?.upstreamSteps?.length ?? 0), 0);

          return (
            <article
              className={"executionStep executionWorkspaceStep " + (active ? "isActive" : "") + (selected ? "isExpanded" : "")}
              key={step.id}
            >
              <button
                type="button"
                className="executionStepButton"
                onClick={() => setExpandedStep(selected ? null : step.id)}
                aria-expanded={selected}
              >
                <div className="stepRail">
                  <div className={"stepMarker " + step.status}>
                    {complete ? "✓" : active ? "•" : index + 1}
                  </div>
                </div>

                <div className="stepDetails">
                  <div className="stepLine">
                    <div className="stepIdentity">
                      <strong>{prettyStepLabel(step)}</strong>
                      <span className="stepKind">{formatStatus(step.kind)}</span>
                    </div>
                    <span className={"stepStatus " + String(step.status)}>{formatStatus(step.status)}</span>
                  </div>

                  <div className="executionStepSummary">
                    <span>{step.objective}</span>
                    {upstreamCount > 0 && <span className="stepHandoff">↳ {upstreamCount} handoffs</span>}
                  </div>

                  <div className="stepTrack"><span style={{ width: stepWidth(step.status) }} /></div>

                  {selected && (
                    <div className="stepDetailGrid">
                      <div><span>Model</span><strong>{step.checkpoint?.model ? String(step.checkpoint.model) : "Selected at runtime"}</strong></div>
                      <div><span>Attempt</span><strong>{Number(step.attempt_count ?? 0)}</strong></div>
                      <div><span>Step ID</span><strong>{String(step.id)}</strong></div>
                      <div><span>Dependencies</span><strong>{Array.isArray(step.depends_on) && step.depends_on.length ? step.depends_on.length : "None"}</strong></div>
                      <div><span>Usage</span><strong>{Number(step.usage_cents_total ?? step.usage_cents ?? 0)}¢</strong></div>
                      <div><span>Evidence</span><strong>{countEvidence(step.result)} packets</strong></div>
                    </div>
                  )}
                </div>
              </button>
            </article>
          );
        })}
      </div>

      <div className="executionActivity">
        <div className="executionActivityHeader">
          <div>
            <strong>Live activity</strong>
            <span>High-level orchestration events</span>
          </div>
          <span>{recentEvents.length ? "Streaming" : "Waiting for events"}</span>
        </div>

        <div className="executionActivityList" aria-live="polite">
          {recentEvents.length === 0 ? (
            <div className="executionActivityEmpty">Execution events will appear here as agents, models and verification stages advance.</div>
          ) : recentEvents.map((item, index) => (
            <div className={"executionActivityItem " + item.tone} key={String(item.id ?? index) + "-" + index}>
              <span className="executionActivityMarker">{item.marker}</span>
              <time>{formatTime(item.created_at)}</time>
              <span className="executionActivityText">{item.text}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function orderStepsByDependencies(steps: any[]) {
  const sourceOrder = new Map(steps.map((step, index) => [String(step.id), index]));
  const byId = new Map(steps.map((step) => [String(step.id), step]));
  const byPlanId = new Map(steps.map((step) => [planStepId(step), step]));

  const dependencyIds = (step: any) => (Array.isArray(step?.depends_on) ? step.depends_on : [])
    .map((dependency: unknown) => String(dependency))
    .map((dependency: string) => byId.has(dependency) ? dependency : String(byPlanId.get(dependency)?.id ?? ""))
    .filter(Boolean);

  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const step of steps) {
    const id = String(step.id);
    const deps = dependencyIds(step);
    indegree.set(id, deps.length);
    for (const dep of deps) {
      edges.set(dep, [...(edges.get(dep) ?? []), id]);
    }
  }

  const queue = steps
    .filter((step) => (indegree.get(String(step.id)) ?? 0) === 0)
    .sort((a, b) => stepPriority(a) - stepPriority(b) || (sourceOrder.get(String(a.id)) ?? 0) - (sourceOrder.get(String(b.id)) ?? 0))
    .map((step) => String(step.id));

  const ordered: any[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    const step = byId.get(id);
    if (!step) continue;
    ordered.push(step);
    for (const next of edges.get(id) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
        queue.sort((a, b) => stepPriority(byId.get(a)) - stepPriority(byId.get(b)) || (sourceOrder.get(a) ?? 0) - (sourceOrder.get(b) ?? 0));
      }
    }
  }

  if (ordered.length !== steps.length) {
    return steps.slice().sort((a, b) => stepPriority(a) - stepPriority(b) || (sourceOrder.get(String(a.id)) ?? 0) - (sourceOrder.get(String(b.id)) ?? 0));
  }
  return ordered;
}

function stepPriority(step: any) {
  const planId = planStepId(step).toLowerCase();
  if (String(step?.kind) === "verification" || planId.includes("verif")) return 3;
  if (planId.includes("writer") || planId.includes("write")) return 2;
  if (planId.includes("analysis") || planId.includes("analy")) return 1;
  if (planId.includes("research") || planId.includes("search")) return 0;
  return 1;
}

function planStepId(step: any) {
  const value = step?.checkpoint?.planStepId;
  return typeof value === "string" && value ? value : String(step?.id ?? "");
}

function prettyStepLabel(step: any) {
  const planId = planStepId(step);
  if (planId === "research_primary") return "Research · primary";
  if (planId === "research_secondary") return "Research · complementary";
  if (planId.includes("analysis")) return "Analysis";
  if (planId.includes("writer")) return "Writer";
  if (String(step?.kind) === "verification") return "Verifier";
  return prettyAgent(step?.agent_id);
}

function prettyAgent(value: unknown) {
  const raw = String(value ?? "specialist").replace(/[_-]+/g, " ").trim();
  return raw ? raw.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Specialist";
}

function formatStatus(value: unknown) {
  return String(value ?? "pending")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stepWidth(value: unknown) {
  const status = String(value);
  if (["verified", "succeeded", "completed"].includes(status)) return "100%";
  if (["running", "executing", "working"].includes(status)) return "58%";
  if (["failed", "cancelled", "rejected"].includes(status)) return "100%";
  return "10%";
}

function shortModel(model: string) {
  return model.replace("@cf/", "").replace("zai-org/", "").replace(/^openai\//, "").replace(/-/g, " ");
}

function countEvidence(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return 0;
  const ids = (result as Record<string, unknown>).evidencePacketIds;
  return Array.isArray(ids) ? ids.length : 0;
}

function executionFocus(status: string) {
  switch (status) {
    case "verified": return "Artifact ready";
    case "failed": return "Failure review";
    case "cancelled": return "Cancelled";
    default: return "Queue ready";
  }
}

function describeEvent(event: EventItem) {
  const type = String(event.event_type ?? "");
  const payload = event.payload ?? {};
  const agent = prettyAgent(payload.agentId);
  const model = payload.model ? shortModel(String(payload.model)) : "";
  let text = "";
  let tone = "neutral";
  let marker = "·";

  switch (type) {
    case "task.progress":
      text = `Execution advanced · ${Number(payload.completedSteps ?? 0)} completed · ${Number(payload.readySteps ?? 0)} ready`;
      marker = "↗";
      break;
    case "step.started":
      text = `${agent} started ${formatStatus(payload.kind ?? "step")}`;
      tone = "active";
      marker = "▶";
      break;
    case "model.selected":
      text = `${agent} selected ${model || "runtime model"}`;
      tone = "active";
      marker = "◉";
      break;
    case "model.handoff.received":
      text = `Handoff received · ${Number(payload.upstreamSteps?.length ?? 0)} upstream packet(s) accepted`;
      tone = "handoff";
      marker = "↳";
      break;
    case "model.completed":
      text = `${agent} completed model turn${Number(payload.toolCallCount ?? 0) ? " · " + Number(payload.toolCallCount) + " tool call(s)" : ""}`;
      marker = "✓";
      tone = "complete";
      break;
    case "model.fallback":
      text = `Model fallback · ${shortModel(String(payload.fromModel ?? "previous"))} → ${shortModel(String(payload.toModel ?? "fallback"))}`;
      tone = "warning";
      marker = "↻";
      break;
    case "tool.failed":
      text = `${agent} tool execution failed · ${String(payload.toolId ?? "tool")}`;
      tone = "warning";
      marker = "!";
      break;
    case "approval.requested":
      text = "Approval requested · " + String(payload.reason ?? "External action requires approval");
      tone = "approval";
      marker = "!";
      break;
    case "step.retry_scheduled":
      text = `Retry scheduled · attempt ${Number(payload.nextAttempt ?? 0)}`;
      tone = "warning";
      marker = "↻";
      break;
    case "step.quota_deferred":
    case "task.quota_deferred":
      text = "Model quota reached · execution deferred to the next allocation window";
      tone = "warning";
      marker = "⏸";
      break;
    case "step.verified":
      text = `${agent} verified the step`;
      tone = "complete";
      marker = "✓";
      break;
    case "task.yielded":
      text = "Worker yielded · queue will resume the run";
      marker = "↺";
      break;
    case "task.budget_exhausted":
    case "task.budget_exceeded":
      text = "Execution stopped · budget boundary reached";
      tone = "warning";
      marker = "!";
      break;
    case "task.failed":
      text = "Task failed · the run is blocked from finalization";
      tone = "warning";
      marker = "!";
      break;
    case "task.verified":
      text = "Task verified · final artifact ready";
      tone = "complete";
      marker = "✓";
      break;
    default:
      return null;
  }

  return {
    id: event.id,
    created_at: event.created_at,
    text,
    tone,
    marker,
  };
}

function formatTime(value: unknown) {
  if (!value) return "--:--";
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return "--:--";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
