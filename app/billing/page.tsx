"use client";


import { OrchestraShell } from "@/components/OrchestraShell";

import { useEffect, useState } from "react";

export default function BillingPage() {
  const [data, setData] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  async function load() {
    const r = await fetch("/api/billing");
    const b = await r.json();
    if (!r.ok) return setMessage(b.error ?? "Billing unavailable");
    setData(b);
  }

  useEffect(() => { void load(); }, []);

  async function checkout(planCode: string, interval: "month" | "year") {
    setBusy(planCode + ":" + interval);
    setMessage("");
    const r = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode, interval }),
    });
    const b = await r.json();
    if (!r.ok) {
      setMessage(b.error ?? "Checkout unavailable");
      setBusy(null);
      return;
    }
    window.location.href = b.url;
  }


  async function cancelSubscription() {
    if (!window.confirm("Schedule this subscription to cancel at the end of the current billing period?")) return;
    setBusy("cancel"); setMessage("");
    const r = await fetch("/api/billing/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    const b = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setMessage(b.error ?? "Cancellation unavailable"); return; }
    setCancelled(true); setMessage("Cancellation scheduled for the end of the current billing period."); await load();
  }

  async function portal() {
    setBusy("portal");
    const r = await fetch("/api/billing/portal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const b = await r.json();
    if (!r.ok) {
      setMessage(b.error ?? "Billing portal unavailable");
      setBusy(null);
      return;
    }
    window.location.href = b.url;
  }

  if (!data) return <OrchestraShell title="Billing & plans" section="Billing"><div className="shell"><section className="card"><b>{message || "Loading billing…"}</b></section></div></OrchestraShell>;

  const quota = data.quota ?? {};
  const plan = data.currentPlan ?? {};
  const subscriptions = data.subscriptions ?? [];
  const invoices = data.invoices ?? [];

  return (
    <OrchestraShell title="Billing & plans" section="Billing"><div className="shell">
      {message && <div className="card" style={{ padding: 14, marginTop: 16 }}>{message}</div>}

      <section className="hero card">
        <div>
          <div className="pill">PLAN PROVISIONING + QUOTAS</div>
          <h2>{plan.name ?? "Starter"} is your current workspace plan.</h2>
          <p className="muted">{plan.description ?? "Plan limits are enforced by the workspace admission layer."}</p>
          {subscriptions[0] && (
            <div className="muted small">
              Subscription: <b>{subscriptions[0].status}</b> · {subscriptions[0].interval} · {subscriptions[0].cancel_at_period_end ? "cancels at period end" : "renews"}
            </div>
          )}
          <div className="composerRow">
            {data.customer?.external_customer_id && <button className="secondary" disabled={busy === "portal"} onClick={portal}>{busy === "portal" ? "Opening…" : "Manage billing"}</button>
            {!subscriptions[0]?.cancel_at_period_end && !cancelled && <button className="secondary" disabled={busy === "cancel"} onClick={cancelSubscription}>{busy === "cancel" ? "Scheduling…" : "Cancel at period end"}</button>}
            {(subscriptions[0]?.cancel_at_period_end || cancelled) && <span className="status verified">CANCELLATION SCHEDULED</span>}}
          </div>
        </div>
        <div className="healthGrid">
          <Metric label="Tasks" value={String(quota.tasks?.used ?? 0) + " / " + String(quota.tasks?.limit ?? 0)} />
          <Metric label="Spend" value={"$" + ((quota.spend?.usedCents ?? 0) / 100).toFixed(2) + " / $" + ((quota.spend?.limitCents ?? 0) / 100).toFixed(2)} />
          <Metric label="Concurrency" value={String(quota.concurrency?.running ?? 0) + " / " + String(quota.concurrency?.limit ?? 0)} />
          <Metric label="Max task" value={"$" + ((quota.maxTaskCostCents ?? 0) / 100).toFixed(2)} />
        </div>
      </section>

      <section className="layout">
        {(data.plans ?? []).map((p: any) => {
          const current = p.code === quota.plan;
          const price = p.billing_mode === "free"
            ? "Free"
            : p.billing_mode === "custom"
              ? "Custom"
              : p.monthly_price_cents != null
                ? "$" + (Number(p.monthly_price_cents) / 100).toFixed(2) + " / month"
                : "Price configured in provider";
          return (
            <div className="card" style={{ padding: 20 }} key={p.code}>
              <div className="pill">{p.code.toUpperCase()}</div>
              <h3 style={{ fontSize: 26, marginBottom: 6 }}>{p.name}</h3>
              <div className="muted small">{p.description}</div>
              <div style={{ fontSize: 24, fontWeight: 900, margin: "14px 0" }}>{price}</div>
              <div className="metricGrid">
                <Metric label="Tasks / mo" value={String(p.monthly_task_limit)} />
                <Metric label="Spend ceiling" value={"$" + (Number(p.monthly_spend_limit_cents) / 100).toFixed(0)} />
                <Metric label="Agents" value={String(p.max_agents)} />
                <Metric label="Members" value={String(p.max_members)} />
              </div>
              <div className="composerRow">
                {current ? <span className="status verified">CURRENT PLAN</span> : p.code === "starter" ? null : (
                  <button disabled={busy === p.code + ":month"} onClick={() => checkout(p.code, "month")}>
                    {busy === p.code + ":month" ? "Opening…" : "Choose plan"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <section className="card opsDashboard">
        <div className="sectionTitle">Quota status</div>
        <Quota label="Monthly tasks" used={Number(quota.tasks?.used ?? 0)} limit={Number(quota.tasks?.limit ?? 0)} />
        <Quota label="Monthly spend" used={Number(quota.spend?.usedCents ?? 0)} limit={Number(quota.spend?.limitCents ?? 0)} currency />
        <Quota label="Concurrency" used={Number(quota.concurrency?.running ?? 0)} limit={Number(quota.concurrency?.limit ?? 0)} />
      </section>

      <section className="card">
        <div className="sectionTitle">Invoices</div>
        {invoices.length === 0 ? <div className="empty">No invoices have been recorded yet.</div> : invoices.map((i: any) => (
          <div className="agentRow" key={i.id}>
            <div>
              <b>{i.status}</b>
              <div className="muted small">{i.currency.toUpperCase()} · due {i.amount_due_cents} · paid {i.amount_paid_cents}</div>
            </div>
            {i.hosted_invoice_url ? <a href={i.hosted_invoice_url} target="_blank" rel="noreferrer">Open invoice</a> : null}
          </div>
        ))}
      </section>
    </div></OrchestraShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><div className="muted small">{label}</div><b>{value}</b></div>;
}

function Quota({ label, used, limit, currency }: { label: string; used: number; limit: number; currency?: boolean }) {
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const u = currency ? "$" + (used / 100).toFixed(2) : String(used);
  const l = currency ? "$" + (limit / 100).toFixed(2) : String(limit);
  return <div style={{ marginBottom: 16 }}><div className="taskHead"><span className="muted small">{label}</span><span className="small">{u} / {l}</span></div><div className="opsBar"><span style={{ width: Math.max(2, percent) + "%" }} /></div></div>;
}
