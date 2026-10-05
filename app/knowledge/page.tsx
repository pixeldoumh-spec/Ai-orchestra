"use client";


import { OrchestraShell } from "@/components/OrchestraShell";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

type DocumentRow = { id: string; filename: string; mime_type: string; size_bytes: number; status: string; provider?: string; local_retrieval_status?: string; local_chunk_count?: number; error?: string | null; created_at: string };
type MemoryRow = { id: string; kind: string; visibility: string; content: string; source_type: string; confidence: number; importance: number; created_at: string; };
type ResultRow = { id: string; source_type: string; filename?: string | null; kind?: string | null; visibility?: string | null; content: string; score?: number; };

export default function KnowledgePage() {
  const [organizationId, setOrganizationId] = useState("");
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [memoryText, setMemoryText] = useState("");
  const [memoryKind, setMemoryKind] = useState("fact");
  const [memoryVisibility, setMemoryVisibility] = useState("workspace");
  const [query, setQuery] = useState("");
  const [includePrivate, setIncludePrivate] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const orgRes = await fetch("/api/agents");
    if (!orgRes.ok) { setMessage(orgRes.status === 401 ? "Sign in first." : "Could not load workspace."); return; }
    const orgData = await orgRes.json();
    const orgId = orgData.organization?.id ?? "";
    setOrganizationId(orgId);
    if (!orgId) { setDocuments([]); setMemories([]); setMessage("Create a workspace before adding knowledge."); return; }
    const [docsRes, memoryRes] = await Promise.all([
      fetch("/api/knowledge/documents?organizationId=" + encodeURIComponent(orgId)),
      fetch("/api/knowledge/memories?organizationId=" + encodeURIComponent(orgId)),
    ]);
    const docsBody = await docsRes.json().catch(() => ({}));
    const memoryBody = await memoryRes.json().catch(() => ({}));
    if (docsRes.ok) setDocuments(docsBody.documents ?? []);
    if (memoryRes.ok) setMemories(memoryBody.memories ?? []);
    setMessage(!docsRes.ok ? docsBody.error ?? "Could not load documents." : !memoryRes.ok ? memoryBody.error ?? "Could not load memory." : "");
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!organizationId || !documents.some((doc) => doc.status === "indexing")) return;
    const timer = window.setInterval(async () => {
      const pending = documents.filter((doc) => doc.status === "indexing").slice(0, 10);
      const refreshed = await Promise.all(pending.map(async (doc) => {
        const res = await fetch("/api/knowledge/documents/" + encodeURIComponent(doc.id) + "?organizationId=" + encodeURIComponent(organizationId));
        if (!res.ok) return doc;
        const body = await res.json().catch(() => ({}));
        return body.document ?? doc;
      }));
      setDocuments((current) => current.map((doc) => refreshed.find((next) => next.id === doc.id) ?? doc));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [organizationId, documents]);

  async function upload(event: FormEvent) {
    event.preventDefault(); if (!file || !organizationId) return;
    setBusy(true); setMessage("Uploading and indexing…");
    try {
      const form = new FormData(); form.append("file", file);
      const res = await fetch("/api/knowledge/documents?organizationId=" + encodeURIComponent(organizationId), { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(body.error ?? "Knowledge upload failed."); return; }
      setFile(null); setMessage(body.document?.status === "ready" ? "Document indexed and ready." : "Document stored; indexing status is shown below."); await load();
    } finally { setBusy(false); }
  }

  async function addMemory(event: FormEvent) {
    event.preventDefault(); if (!memoryText.trim() || !organizationId) return;
    setBusy(true); setMessage("Saving workspace memory…");
    try {
      const res = await fetch("/api/knowledge/memories?organizationId=" + encodeURIComponent(organizationId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: memoryText, kind: memoryKind, visibility: memoryVisibility }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(body.error ?? "Memory save failed."); return; }
      setMemoryText(""); setMessage(body.duplicate ? "That memory already exists." : "Memory saved to this workspace."); await load();
    } finally { setBusy(false); }
  }

  async function retrieve(event: FormEvent) {
    event.preventDefault(); if (!query.trim() || !organizationId) return;
    setBusy(true); setMessage("Retrieving tenant knowledge…");
    try {
      const res = await fetch("/api/knowledge/retrieve?organizationId=" + encodeURIComponent(organizationId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, limit: 8, includePrivate }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage(body.error ?? "Retrieval failed."); return; }
      setResults(body.results ?? []); setMessage(`${body.results?.length ?? 0} result(s) from workspace knowledge.`);
    } finally { setBusy(false); }
  }

  async function removeMemory(id: string) {
    if (!organizationId) return;
    const res = await fetch("/api/knowledge/memories/" + encodeURIComponent(id) + "?organizationId=" + encodeURIComponent(organizationId), { method: "DELETE" });
    if (res.ok) await load(); else { const body = await res.json().catch(() => ({})); setMessage(body.error ?? "Could not remove memory."); }
  }

  function formatBytes(bytes: number) { if (bytes < 1024) return bytes + " B"; if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"; return (bytes / 1024 / 1024).toFixed(1) + " MB"; }

  return (
    <OrchestraShell title="Knowledge" section="Knowledge"><div className="shell">
      <section className="card">
        <div className="sectionTitle">Workspace memory</div>
        <p className="muted small">Durable facts, preferences, decisions and procedures. Workspace memory is shared inside this organization; private memory is visible only to you.</p>
        <form onSubmit={addMemory} className="composerRow">
          <input value={memoryText} onChange={(e) => setMemoryText(e.target.value)} placeholder="e.g. Our release process requires verification before production" maxLength={12000} disabled={busy} />
          <select value={memoryKind} onChange={(e) => setMemoryKind(e.target.value)} disabled={busy}><option value="fact">Fact</option><option value="preference">Preference</option><option value="decision">Decision</option><option value="procedure">Procedure</option><option value="context">Context</option></select>
          <select value={memoryVisibility} onChange={(e) => setMemoryVisibility(e.target.value)} disabled={busy}><option value="workspace">Workspace</option><option value="private">Private</option></select>
          <button type="submit" disabled={!memoryText.trim() || !organizationId || busy}>Remember</button>
        </form>
      </section>

      <section className="card">
        <div className="sectionTitle">Knowledge retrieval</div>
        <p className="muted small">Semantic retrieval spans this workspace's indexed document chunks and durable memories. Private memory is never exposed to agents; this manual control can include it only for the authenticated owner. Query text is not stored; telemetry keeps only a hash and result counts.</p>
        <form onSubmit={retrieve} className="composerRow"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search workspace knowledge…" disabled={busy} /><button type="submit" disabled={!query.trim() || !organizationId || busy}>Retrieve</button></form><label className="muted small" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}><input type="checkbox" checked={includePrivate} onChange={(e) => setIncludePrivate(e.target.checked)} disabled={busy} /> Include my private memory in this manual search</label>
        {results.map((item) => <div className="agentRow" key={item.id}><div className="agentDot"/><div><b>{item.source_type}{item.filename ? ` · ${item.filename}` : item.kind ? ` · ${item.kind}` : ""}</b><div className="muted small">{item.content}</div></div><div className="agentRight"><span>{typeof item.score === "number" ? item.score.toFixed(2) : "match"}</span></div></div>)}
      </section>

      <section className="card">
        <div className="sectionTitle">Document ingestion</div>
        <p className="muted small">Upload trusted workspace material for agent retrieval. Files remain in private tenant storage and are indexed into the workspace retrieval store.</p>
        <form onSubmit={upload} className="composerRow"><input type="file" accept=".pdf,.doc,.docx,.pptx,.txt,.md,.csv,.json,.html,.js,.ts,.py,.java,.c,.cpp,.cs,.go,.php,.rb,.sh" onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] ?? null)} disabled={busy}/><button type="submit" disabled={!file || !organizationId || busy}>{busy ? "Working…" : "Add document"}</button></form>
        {documents.map((doc) => <div className="agentRow" key={doc.id}><div className="agentDot"/><div><b>{doc.filename}</b><div className="muted small">{doc.mime_type} · {formatBytes(doc.size_bytes)} · local {doc.local_retrieval_status ?? "n/a"} ({doc.local_chunk_count ?? 0} chunks)</div>{doc.error && <div className="muted small">{doc.error}</div>}</div><div className="agentRight"><span>{doc.status}</span></div></div>)}
        {documents.length === 0 && <div className="empty">No workspace documents yet.</div>}
      </section>

      <section className="card">
        <div className="sectionTitle">Stored memories</div>
        {memories.length === 0 ? <div className="empty">No durable memories yet.</div> : memories.map((memory) => <div className="agentRow" key={memory.id}><div className="agentDot"/><div><b>{memory.kind} · {memory.visibility}</b><div className="muted small">{memory.content}</div></div><div className="agentRight"><button onClick={() => void removeMemory(memory.id)} disabled={busy}>Forget</button></div></div>)}
      </section>

      {message && <div className="muted small" style={{ marginTop: 12 }}>{message}</div>}
    </div></OrchestraShell>
  );
}
