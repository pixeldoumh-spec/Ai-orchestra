"use client";

import { useEffect, useMemo, useState } from "react";
import { OrchestraShell } from "@/components/OrchestraShell";

type Connector=any; type Agent=any; type Binding=any; type Credential=any;

export default function ConnectorsPage(){
 const [data,setData]=useState<{organization:any;connectors:Connector[];bindings:Binding[]}|null>(null);
 const [agents,setAgents]=useState<Agent[]>([]);
 const [message,setMessage]=useState("");
 const [busy,setBusy]=useState("");
 const [selected,setSelected]=useState<string>("");
 const [credentials,setCredentials]=useState<Credential[]>([]);
 const [credentialName,setCredentialName]=useState("");
 const [secret,setSecret]=useState("");
 const [credentialScopes,setCredentialScopes]=useState("");
 const [credentialScheme,setCredentialScheme]=useState("api_key");
 const [bindingAgent,setBindingAgent]=useState("");
 const [bindingCredential,setBindingCredential]=useState("");
 const [allowedTools,setAllowedTools]=useState("external.action");
 const [bindingScopes,setBindingScopes]=useState("");
 const [priority,setPriority]=useState("100");

 async function load(){
  const [cr,ar]=await Promise.all([fetch("/api/connectors"),fetch("/api/agents")]);
  const cb=await cr.json().catch(()=>({})); const ab=await ar.json().catch(()=>({}));
  if(!cr.ok){setMessage(cb.error??"Connectors unavailable");return;}
  setData(cb); setAgents(ab.agents??[]);
  if(!selected&&cb.connectors?.length)setSelected(cb.connectors[0].id);
 }
 async function loadCredentials(id:string){
  const r=await fetch("/api/connectors/"+encodeURIComponent(id)+"/credentials");
  const b=await r.json().catch(()=>({}));
  if(r.ok)setCredentials(b.credentials??[]); else setMessage(b.error??"Credential metadata unavailable");
 }
 useEffect(()=>{void load();},[]);
 useEffect(()=>{if(selected)void loadCredentials(selected);},[selected]);
 useEffect(()=>{if(!bindingAgent&&agents.length)setBindingAgent(agents[0].id);},[agents,bindingAgent]);

 async function updateStatus(id:string,status:"active"|"degraded"|"disabled"){
  setBusy(id);
  const r=await fetch("/api/connectors/"+id+"?organizationId="+encodeURIComponent(data?.organization?.id??""),{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status})});
  const b=await r.json().catch(()=>({}));setBusy("");
  if(!r.ok){setMessage(b.error??"Status update failed");return;} await load();
 }
 async function resetCircuit(id:string){
  setBusy("reset:"+id);
  const r=await fetch("/api/connectors/"+id+"/health",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"reset_circuit"})});
  const b=await r.json().catch(()=>({}));setBusy("");
  if(!r.ok){setMessage(b.error??"Circuit reset failed");return;}setMessage("Connector health circuit reset.");await load();
 }
 async function addCredential(){
  if(!selected)return;
  setBusy("credential");setMessage("");
  const r=await fetch("/api/connectors/"+selected+"/credentials",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:credentialName,secret,scopes:credentialScopes.split(",").map(s=>s.trim()).filter(Boolean),authScheme:credentialScheme,expiresAt:null})});
  const b=await r.json().catch(()=>({}));setBusy("");
  if(!r.ok){setMessage(b.error??"Could not store credential");return;}
  setCredentialName("");setSecret("");setCredentialScopes("");setMessage("Credential stored securely.");await loadCredentials(selected);
 }
 async function bind(){
  if(!selected)return;
  setBusy("binding");setMessage("");
  const r=await fetch("/api/connectors/"+selected+"/bindings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentId:bindingAgent,credentialId:bindingCredential||null,allowedTools:allowedTools.split(",").map(s=>s.trim()).filter(Boolean),scopes:bindingScopes.split(",").map(s=>s.trim()).filter(Boolean),priority:Number(priority)||100})});
  const b=await r.json().catch(()=>({}));setBusy("");
  if(!r.ok){setMessage(b.error??"Could not bind connector");return;}
  setMessage("Agent connector binding saved.");await load();
 }

 const current=useMemo(()=>data?.connectors.find(c=>c.id===selected),[data,selected]);
 const currentBindings=useMemo(()=>data?.bindings.filter(b=>b.connectorId===selected)??[],[data,selected]);

 return <OrchestraShell title="Connectors" section="Connectors"><div className="connectorLayout">
  <div className="connectorList card">
   <div className="sectionTitle">Connected tools</div>
   <div className="muted small">Credentials and agent access stay inside your workspace boundary.</div>
   {data?.connectors?.map(c=><button type="button" key={c.id} className={"connectorItem "+(selected===c.id?"selected":"")} onClick={()=>setSelected(c.id)}>
    <span className={"connectorIndicator "+c.status}/><span><strong>{c.name}</strong><small>{c.kind} · {c.authScheme}</small></span><span className="connectorStatus">{c.status}</span>
   </button>)}
   {(!data||data.connectors.length===0)&&<div className="empty">{message||"No connectors installed yet. Install one from Marketplace."}</div>}
   <a className="connectorBrowse" href="/marketplace">Browse marketplace →</a>
  </div>

  {current?<section className="connectorDetail card">
   <div className="connectorHead"><div><div className="runEyebrow">CONNECTOR</div><h2>{current.name}</h2><p className="muted small">{current.baseUrl??"Reserved connector"} · v{current.version}</p></div><span className={"status "+(current.status==="active"?"verified":"")}>{current.status}</span></div>

   <div className="connectorMetrics">
    <div className="metric"><span className="muted tiny">Circuit</span><b>{current.circuitState}</b><small>{current.consecutiveFailures??0} consecutive failures</small></div>
    <div className="metric"><span className="muted tiny">Fallback</span><b>{current.fallbackConnectorId?"Configured":"None"}</b><small>Route fallback</small></div>
    <div className="metric"><span className="muted tiny">Credentials</span><b>{credentials.length}</b><small>Metadata only</small></div>
    <div className="metric"><span className="muted tiny">Bindings</span><b>{currentBindings.length}</b><small>Agent access paths</small></div>
   </div>

   <div className="connectorActions">
    <button onClick={()=>void updateStatus(current.id,"active")} disabled={!!busy}>Enable</button>
    <button className="secondary" onClick={()=>void updateStatus(current.id,"degraded")} disabled={!!busy}>Degrade</button>
    <button className="secondary" onClick={()=>void updateStatus(current.id,"disabled")} disabled={!!busy}>Disable</button>
    <button className="secondary" onClick={()=>void resetCircuit(current.id)} disabled={!!busy}>Reset circuit</button>
   </div>

   <div className="connectorSection">
    <div className="sectionTitle">Credentials</div>
    <div className="muted tiny">Secrets are encrypted server-side and are never returned to this UI.</div>
    {credentials.map(c=><div className="credentialRow" key={c.id}><div><strong>{c.name}</strong><span>{c.auth_scheme} · key v{c.key_version} · {c.status}</span></div><small>{c.expires_at?("expires "+formatDate(c.expires_at)):"no expiry"}</small></div>)}
    <div className="connectorForm">
     <input placeholder="Credential name" value={credentialName} onChange={e=>setCredentialName(e.target.value)}/>
     <select value={credentialScheme} onChange={e=>setCredentialScheme(e.target.value)}><option value="none">none</option><option value="bearer">bearer</option><option value="api_key">api_key</option><option value="hmac">hmac</option></select>
     <input type="password" placeholder="Secret" value={secret} onChange={e=>setSecret(e.target.value)} autoComplete="new-password"/>
     <input placeholder="Scopes, comma separated" value={credentialScopes} onChange={e=>setCredentialScopes(e.target.value)}/>
     <button disabled={!credentialName.trim()||!secret||busy==="credential"} onClick={()=>void addCredential()}>{busy==="credential"?"Saving…":"Store credential"}</button>
    </div>
   </div>

   <div className="connectorSection">
    <div className="sectionTitle">Agent bindings</div>
    {currentBindings.map(b=><div className="credentialRow" key={b.id}><div><strong>{prettyAgent(b.agentId)}</strong><span>{(b.allowedTools??[]).join(" · ")}</span></div><small>priority {b.priority} · {b.status}</small></div>)}
    <div className="connectorForm">
     <select value={bindingAgent} onChange={e=>setBindingAgent(e.target.value)}>{agents.map(a=><option key={a.id} value={a.id}>{a.name??a.id}</option>)}</select>
     <select value={bindingCredential} onChange={e=>setBindingCredential(e.target.value)}><option value="">No credential</option>{credentials.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
     <input placeholder="Allowed tools, comma separated" value={allowedTools} onChange={e=>setAllowedTools(e.target.value)}/>
     <input placeholder="Scopes, comma separated" value={bindingScopes} onChange={e=>setBindingScopes(e.target.value)}/>
     <input type="number" min="0" max="10000" placeholder="Priority" value={priority} onChange={e=>setPriority(e.target.value)}/>
     <button disabled={!bindingAgent||!allowedTools.trim()||busy==="binding"} onClick={()=>void bind()}>{busy==="binding"?"Saving…":"Save binding"}</button>
    </div>
   </div>

   {message&&<div className="friendlyMessage">{message}</div>}
  </section>:<section className="connectorDetail card"><div className="empty">Select a connector.</div></section>}
 </div></OrchestraShell>
}

function prettyAgent(v:string){const s=String(v??"agent").replace(/[_-]+/g," ").trim();return s?s[0].toUpperCase()+s.slice(1):"Agent"}
function formatDate(v:string){try{return new Date(v).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}catch{return v}}
