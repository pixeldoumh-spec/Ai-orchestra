"use client";

import { useEffect, useMemo, useState } from "react";
import { OrchestraShell } from "@/components/OrchestraShell";

const presets:Record<string,string>={
  research:"Focus on primary sources, evidence quality, conflicts and explicit unknowns. Cite consequential claims and report gaps instead of guessing.",
  analysis:"Be a rigorous decision layer. Compare evidence, detect contradictions, preserve uncertainty and produce defensible conclusions.",
  writer:"Turn verified material into clear user-facing deliverables. Prefer useful tables, headings and concise recommendations without adding unsupported facts.",
  verifier:"Act as an adversarial quality gate. Check completeness, evidence support, contradictions and policy compliance before anything is finalized.",
};

function infer(text:string,existing:string[]){
  const lower=text.toLowerCase();
  const groups:[string,string[]][]=[
    ["research",["research","investigate","source","evidence","web"]],
    ["analysis",["analysis","analy","reason","compare","strategy","evaluate"]],
    ["writing",["write","writing","report","draft","summarize","content"]],
    ["coding",["code","coding","program","developer","debug"]],
    ["data",["data","sql","dataset","analytics","spreadsheet"]],
    ["vision",["image","vision","visual"]],
  ];
  const out=[...existing];
  for(const [cap,words] of groups) if(words.some(w=>lower.includes(w))&&!out.includes(cap)) out.push(cap);
  const budget=text.match(/(?:budget|under|below|limit)\D{0,12}(\d{1,6})/i)?.[1];
  return {capabilities:out.slice(0,24),budget:budget?Math.max(0,Math.min(1000000,Number(budget))):null};
}

export default function AgentsPage(){
  const [agents,setAgents]=useState<any[]>([]);
  const [selected,setSelected]=useState("");
  const [intent,setIntent]=useState("");
  const [name,setName]=useState("");
  const [description,setDescription]=useState("");
  const [capabilities,setCapabilities]=useState<string[]>([]);
  const [budget,setBudget]=useState(0);
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);

  async function load(){
    const r=await fetch("/api/agents"); const b=await r.json().catch(()=>({}));
    if(!r.ok){setMessage(b.error??"Sign in to configure agents.");return;}
    const list=b.agents??[]; setAgents(list);
    const current=list.find((a:any)=>a.id===selected)||list[0];
    if(current){setSelected(current.id);setName(current.name);setDescription(current.description);setCapabilities(current.capabilities??[]);setBudget(Number(current.budgetCents??0));}
  }
  useEffect(()=>{void load()},[]);

  const preview=useMemo(()=>intent?infer(intent,capabilities):{capabilities,budget:null},[intent,capabilities]);
  const current=agents.find(a=>a.id===selected);

  function choose(id:string){
    const a=agents.find(x=>x.id===id); if(!a)return;
    setSelected(id);setName(a.name);setDescription(a.description);setCapabilities(a.capabilities??[]);setBudget(Number(a.budgetCents??0));setIntent("");
  }

  async function save(){
    if(!current)return;
    setBusy(true);setMessage("");
    const r=await fetch("/api/agents/"+encodeURIComponent(current.id),{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name,description,capabilities,budgetCents:preview.budget??budget,naturalLanguage:intent})});
    const b=await r.json().catch(()=>({}));
    setBusy(false);
    if(!r.ok){setMessage(b.error??"Agent configuration failed.");return;}
    setMessage("Agent configuration saved.");
    await load();
  }

  return <OrchestraShell title="Agents" section="Agents"><div className="agentStudio">
    <section className="agentStudioHero">
      <div><div className="pill">NATURAL-LANGUAGE AGENT CONFIGURATION</div><h2>Tell each specialist how you want it to work.</h2><p className="muted">Plain English controls the agent's role, description and capabilities. Permissions, tools and side effects remain governed separately by the workspace.</p></div>
    </section>

    <div className="agentStudioGrid">
      <section className="card agentCatalog">
        <div className="sectionTitle">Your specialists</div>
        {agents.map(a=><button type="button" key={a.id} className={"agentCatalogItem "+(a.id===selected?"selected":"")} onClick={()=>choose(a.id)}>
          <span className={"agentHealth "+a.status}/><span><strong>{a.name}</strong><small>{a.description}</small></span><b>→</b>
        </button>)}
      </section>

      <section className="card agentConfig">
        {!current?<div className="empty">Loading agents…</div>:<>
          <div className="agentConfigHead"><div><span className="agentConfigEyebrow">CONFIGURE {current.id.toUpperCase()}</span><h3>{current.name}</h3></div><span className="status mini">{current.status}</span></div>

          <label>Describe the behavior you want
            <textarea className="agentIntent" value={intent} onChange={e=>setIntent(e.target.value)} placeholder={presets[current.id]??"Example: Focus on concise, evidence-backed work and clearly flag uncertainty."}/>
          </label>
          <div className="agentPresetRow">{["Use recommended behavior","Be concise","Be evidence-first"].map((label,i)=><button key={label} type="button" className="secondary" onClick={()=>i===0?setIntent(presets[current.id]??""):i===1?setIntent("Be concise and prioritize the most useful information."):setIntent("Be evidence-first, cite consequential claims and clearly flag uncertainty.")}>{label}</button>)}</div>

          <div className="agentFieldGrid">
            <label>Display name<input value={name} onChange={e=>setName(e.target.value)} /></label>
            <label>Budget (cents)<input type="number" min={0} max={1000000} value={budget} onChange={e=>setBudget(Math.max(0,Math.min(1000000,Number(e.target.value)||0)))} /></label>
          </div>
          <label>Role description<textarea value={description} onChange={e=>setDescription(e.target.value)} /></label>

          <div className="agentCapabilityBox"><div className="sectionTitle">Interpreted capabilities</div><div className="capabilityChips">{preview.capabilities.map(cap=><span key={cap}>{cap}</span>)}{preview.budget!=null&&<span>budget {preview.budget}¢</span>}</div><div className="muted tiny">Natural-language interpretation is intentionally bounded: it cannot grant new permissions, tools, connectors or external-action authority.</div></div>

          <div className="agentConfigFooter"><span className="muted tiny">Changes apply to future orchestration plans.</span><button type="button" onClick={save} disabled={busy}>{busy?"Saving…":"Save agent configuration"}</button></div>
        </>}
      </section>
    </div>

    {message&&<div className="friendlyMessage" role="status">{message}</div>}
  </div></OrchestraShell>
}
