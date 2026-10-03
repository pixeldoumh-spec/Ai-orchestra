"use client";

import { useState } from "react";

export default function Home() {
  const [goal, setGoal] = useState("Prepare a concise sales report");
  const [task, setTask] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    setTask(null);
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal }),
    });
    const data = await response.json();
    setTask(data);
    setLoading(false);
  }

  return (
    <main className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div>
          <div className="pill">V1 · Agent Control Plane</div>
          <h1 style={{ fontSize: 42, margin: "14px 0 8px" }}>Orchestrator</h1>
          <p className="muted" style={{ maxWidth: 720, fontSize: 17 }}>
            One goal in. Multiple specialized agents. Verified outcome out.
          </p>
        </div>
      </div>

      <section className="card" style={{ padding: 20, marginTop: 24 }}>
        <label htmlFor="goal" style={{ fontWeight: 700 }}>Goal</label>
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <input id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} style={{ flex: 1, padding: 13, border: "1px solid #d1d5db", borderRadius: 10 }} />
          <button onClick={run} disabled={loading} style={{ padding: "13px 18px", border: 0, borderRadius: 10, background: "#111827", color: "white", fontWeight: 700 }}>
            {loading ? "Running…" : "Run workflow"}
          </button>
        </div>
      </section>

      <section className="grid three" style={{ marginTop: 16 }}>
        {["Agent registry", "Permission gateway", "Verification"].map((title, i) => (
          <div className="card" key={title} style={{ padding: 18 }}>
            <div style={{ fontWeight: 750 }}>{title}</div>
            <div className="muted" style={{ marginTop: 7 }}>{["4 agents registered", "Tool access stays policy-bound", "Final step must verify"][i]}</div>
          </div>
        ))}
      </section>

      {task && (
        <section className="card" style={{ padding: 20, marginTop: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>TASK</div>
              <div style={{ fontWeight: 800 }}>{task.id}</div>
            </div>
            <div className="pill">{task.status}</div>
          </div>
          <div style={{ marginTop: 18 }} className="grid">
            {task.steps?.map((step: any) => (
              <div key={step.id} style={{ padding: 14, border: "1px solid #e5e7eb", borderRadius: 12 }}>
                <div style={{ fontWeight: 700 }}>{step.agentId}</div>
                <div className="muted" style={{ marginTop: 3 }}>{step.objective}</div>
                <div style={{ marginTop: 8, fontSize: 13 }}>{step.status}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
