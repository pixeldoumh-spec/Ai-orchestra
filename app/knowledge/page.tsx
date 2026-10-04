"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

type DocumentRow = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  error?: string | null;
  created_at: string;
};

export default function KnowledgePage() {
  const [organizationId, setOrganizationId] = useState<string>("");
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const orgRes = await fetch("/api/agents");
    if (!orgRes.ok) {
      setMessage(orgRes.status === 401 ? "Sign in first." : "Could not load workspace.");
      return;
    }
    const orgData = await orgRes.json();
    const orgId = orgData.organization?.id ?? "";
    setOrganizationId(orgId);
    if (!orgId) {
      setDocuments([]);
      setMessage("Create a workspace before adding knowledge.");
      return;
    }
    const docsRes = await fetch("/api/knowledge/documents?organizationId=" + encodeURIComponent(orgId));
    if (docsRes.ok) {
      const body = await docsRes.json();
      setDocuments(body.documents ?? []);
      setMessage("");
    } else {
      const body = await docsRes.json().catch(() => ({}));
      setMessage(body.error ?? "Could not load documents.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!organizationId || !documents.some((doc) => doc.status === "indexing")) return;
    const timer = window.setInterval(async () => {
      const pending = documents.filter((doc) => doc.status === "indexing").slice(0, 10);
      const refreshed = await Promise.all(
        pending.map(async (doc) => {
          const res = await fetch(
            "/api/knowledge/documents/" + encodeURIComponent(doc.id) +
            "?organizationId=" + encodeURIComponent(organizationId),
          );
          if (!res.ok) return doc;
          const body = await res.json().catch(() => ({}));
          return body.document ?? doc;
        }),
      );
      setDocuments((current) => current.map((doc) => refreshed.find((next) => next.id === doc.id) ?? doc));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [organizationId, documents]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || !organizationId) return;
    setBusy(true);
    setMessage("Uploading and indexing…");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(
        "/api/knowledge/documents?organizationId=" + encodeURIComponent(organizationId),
        { method: "POST", body: form },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(body.error ?? "Knowledge upload failed.");
        return;
      }
      setFile(null);
      setMessage(
        body.document?.status === "ready"
          ? "Document indexed and ready."
          : "Document stored; indexing status is shown below.",
      );
      await load();
    } finally {
      setBusy(false);
    }
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">KNOWLEDGE · V6.2</div>
          <h1>Workspace knowledge</h1>
        </div>
        <div className="topMeta">
          <a href="/">Orchestrator</a>
          <a href="/network">Agent Network</a>
          <a href="/enterprise">Enterprise</a>
        </div>
      </header>

      <section className="card">
        <div className="sectionTitle">Document ingestion</div>
        <p className="muted small">
          Upload trusted workspace material for agent retrieval. Files are kept in private
          tenant storage and indexed into the workspace retrieval store.
        </p>

        <form onSubmit={upload} className="composerRow">
          <input
            type="file"
            accept=".pdf,.doc,.docx,.pptx,.txt,.md,.csv,.json,.html,.js,.ts,.py,.java,.c,.cpp,.cs,.go,.php,.rb,.sh"
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setFile(event.target.files?.[0] ?? null)
            }
            disabled={busy}
          />
          <button type="submit" disabled={!file || !organizationId || busy}>
            {busy ? "Indexing…" : "Add to knowledge"}
          </button>
        </form>

        {message && <div className="muted small" style={{ marginTop: 12 }}>{message}</div>}
      </section>

      <section className="card">
        <div className="sectionTitle">Indexed documents</div>
        {documents.length === 0 ? (
          <div className="empty">No workspace documents yet.</div>
        ) : (
          documents.map((doc) => (
            <div className="agentRow" key={doc.id}>
              <div className="agentDot" />
              <div>
                <b>{doc.filename}</b>
                <div className="muted small">
                  {doc.mime_type} · {formatBytes(doc.size_bytes)}
                </div>
                {doc.error && <div className="muted small">{doc.error}</div>}
              </div>
              <div className="agentRight">
                <span>{doc.status}</span>
              </div>
            </div>
          ))
        )}
      </section>
    </main>
  );
}
