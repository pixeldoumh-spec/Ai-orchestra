"use client";


import { OrchestraShell } from "@/components/OrchestraShell";

import { useEffect, useState } from "react";

export default function MarketplacePage() {
  const [data, setData] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});

  async function load() {
    const r = await fetch("/api/marketplace/connectors");
    const b = await r.json();
    if (!r.ok) return setMessage(b.error ?? "Marketplace unavailable");
    setData(b);
  }

  useEffect(() => { void load(); }, []);

  async function install(slug: string) {
    setBusy(slug);
    setMessage("");
    const r = await fetch("/api/marketplace/connectors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogSlug: slug, baseUrl: baseUrls[slug] || undefined }),
    });
    const b = await r.json();
    if (!r.ok) setMessage(b.error ?? "Installation failed");
    else await load();
    setBusy(null);
  }

  async function uninstall(slug: string) {
    setBusy(slug);
    const r = await fetch("/api/marketplace/connectors/" + encodeURIComponent(slug), { method: "DELETE" });
    const b = await r.json();
    if (!r.ok) setMessage(b.error ?? "Uninstall failed");
    else await load();
    setBusy(null);
  }

  if (!data) return <OrchestraShell title="Marketplace" section="Marketplace"><div className="shell"><section className="card"><b>{message || "Loading marketplace…"}</b></section></div></OrchestraShell>;

  const installs = new Map<string, any>(
    (data.installs ?? []).map((x: any) => [String(x.catalog_slug), x] as [string, any]),
  );

  return (
    <OrchestraShell title="Marketplace" section="Marketplace"><div className="shell">
      {message && <div className="card" style={{ padding: 14, marginTop: 16 }}>{message}</div>}

      <section className="hero card">
        <div>
          <div className="pill">MANIFEST-BASED CONNECTORS</div>
          <h2>Install governed connector packages without granting hidden authority.</h2>
          <p className="muted">Marketplace entries install connector metadata only. Credentials, agent bindings, approval policy and execution remain workspace-owned.</p>
        </div>
        <div className="healthGrid">
          <Metric label="Catalog" value={String((data.catalog ?? []).length)} />
          <Metric label="Installed" value={String((data.installs ?? []).filter((x: any) => x.status === "active").length)} />
          <Metric label="Credentials" value="Workspace-owned" />
          <Metric label="Writes" value="Approval-gated" />
        </div>
      </section>

      <section className="layout">
        {(data.catalog ?? []).map((c: any) => {
          const installed = installs.get(c.slug);
          const active = installed?.status === "active";
          return (
            <div className="card" style={{ padding: 20 }} key={c.slug}>
              <div className="pill">{c.category.toUpperCase()}</div>
              <h3 style={{ fontSize: 25, marginBottom: 6 }}>{c.name}</h3>
              <div className="muted small">{c.description}</div>
              <div className="muted tiny">{c.auth_scheme} auth · v{c.version} · {(c.categories ?? []).join(" · ")}</div>
              {c.manifest?.requires_base_url && (
                <input
                  style={{ width: "100%", marginTop: 12 }}
                  placeholder="https://api.example.com"
                  value={baseUrls[c.slug] ?? ""}
                  onChange={(e) => setBaseUrls((old) => ({ ...old, [c.slug]: e.target.value }))}
                />
              )}
              <div className="composerRow">
                {active ? (
                  <>
                    <span className="status verified">INSTALLED</span>
                    <button className="secondary" disabled={busy === c.slug} onClick={() => uninstall(c.slug)}>Uninstall</button>
                  </>
                ) : (
                  <button disabled={busy === c.slug} onClick={() => install(c.slug)}>{busy === c.slug ? "Installing…" : "Install connector"}</button>
                )}
              </div>
              <div className="muted tiny">Execution stays disabled/degraded until the required credential and agent binding exist.</div>
            </div>
          );
        })}
      </section>
    </div></OrchestraShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><div className="muted small">{label}</div><b>{value}</b></div>;
}
