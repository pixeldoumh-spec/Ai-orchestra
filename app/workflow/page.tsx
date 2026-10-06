"use client";

import { useEffect, useMemo, useState } from "react";
import { OrchestraShell } from "@/components/OrchestraShell";

type Agent = any;
type Step = { id:string; agentId:string; objective:string; dependsOn:string[]; maxAttempts:number; kind:"work"|"verification"; verifies:string[] };

const seedStages = [
  ["research_primary","research","Research · primary","Gather the most relevant facts, sources and inputs needed to satisfy the goal.",[]],
  ["research_secondary","research","Research · complementary","Independently gather counterpoints, edge cases and missing evidence.",[]],
  ["analysis","analysis","Analysis","Synthesize the research into reliable conclusions, contradictions and decision points.",["research_primary","research_secondary"]],
  ["writer","writer","Writer","Turn the verified analysis into the requested user-facing deliverable.",["analysis"]],
  ["verifier","verifier","Verifier","Audit completeness, evidence support, contradictions and final format before release.",["writer"]],
];

function slug(value:string){return value.toLowerCase().trim().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").slice(0,52)||"step"}
function pretty(id:string){return id.replace(/[_-]+/g," ").replace(/\b\w/g,c=>c.toUpperCase())}

export default function WorkflowStudio(){
  const [agents,setAgents]=useState<Agent[]>([]);
  const [goal,setGoal]=useState("Prepare a concise weekly business report");
  const [steps,setSteps]=useState<Step[]>([]);
  const [dragId,setDragId]=useState("");
  const [selected,setSelected]=useState("");
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);

  useEffect(()=>{
    void fetch("/api/agents").then(async r=>{
      const d=await r.json();
      if(!r.ok){setMessage(d.error??"Sign in to use Workflow Studio");return;}
      const list=d.agents??[]; setAgents(list);
      if(!steps.length){
        const pick=(id:string,cap:string)=>{
          const exact=list.find((a:any)=>a.id===id && a.status!=="offline");
          return exact?.id ?? list.find((a:any)=>a.capabilities?.includes(cap) && a.status!=="offline")?.id ?? list.find((a:any)=>a.status!=="offline")?.id ?? id;
        };
        setSteps(seedStages.map(([id,agent,name,objective,deps])=>({id:String(id),agentId:pick(String(agent),String(agent)),objective:String(objective),dependsOn:(deps as string[]),maxAttempts:3,kind:id==="verifier"?"verification":"work",verifies:id==="verifier"?["writer"]:[]})));
      }
    }).catch(()=>setMessage("Could not load agents."));
  },[steps.length]);

  const activeStep=steps.find(s=>s.id===selected)??steps[0];
  const agentMap=useMemo(()=>new Map(agents.map(a=>[a.id,a])),[agents]);

  function reorder(from:string,to:string){
    if(!from||from===to)return;
    setSteps(current=>{
      const copy=[...current]; const i=copy.findIndex(s=>s.id===from), j=copy.findIndex(s=>s.id===to);
      if(i<0||j<0)return current;
      const [item]=copy.splice(i,1); copy.splice(j,0,item); return copy;
    });
  }
  function move(id:string,dir:number){
    setSteps(current=>{
      const copy=[...current]; const i=copy.findIndex(s=>s.id===id); const j=i+dir;
      if(i<0||j<0||j>=copy.length)return current;
      [copy[i],copy[j]]=[copy[j],copy[i]]; return copy;
    });
  }
  function updateStep(id:string,patch:Partial<Step>){setSteps(current=>current.map(s=>s.id===id?{...s,...patch}:s))}
  function addStep(){
    const base="custom_stage_"+(steps.length+1);
    const next={id:slug(base),agentId:agents.find(a=>a.status!=="offline")?.id??"research",objective:"Define the work this stage should complete.",dependsOn:steps.length?[steps[Math.max(0,steps.length-2)].id]:[],maxAttempts:3,kind:"work" as const,verifies:[]};
    setSteps(current=>[...current.slice(0,-1),next,current[current.length-1]]);
    setSelected(next.id);
  }
  function removeStep(id:string){
    if(steps.length<=5){setMessage("Keep the four core roles and verifier; you can edit their objectives and dependencies.");return;}
    setSteps(current=>current.filter(s=>s.id!==id).map(s=>({...s,dependsOn:s.dependsOn.filter(d=>d!==id),verifies:s.verifies.filter(d=>d!==id)})));
  }

  async function runWorkflow(){
    setMessage("");
    if(!goal.trim()){setMessage("Describe the outcome first.");return;}
    setBusy(true);
    const plan={version:"v3",rationale:"User-designed workflow from Workflow Studio.",steps};
    const r=await fetch("/api/tasks",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({goal:goal.trim(),maxCostCents:500,workflowPlan:plan})});
    const b=await r.json().catch(()=>({}));
    if(!r.ok){setMessage(typeof b.error==="string"?b.error:"The workflow needs adjustment before it can run.");setBusy(false);return;}
    const start=await fetch("/api/tasks/"+encodeURIComponent(b.task.id)+"/start",{method:"POST"});
    const sb=await start.json().catch(()=>({}));
    setBusy(false);
    if(!start.ok){setMessage(sb.error??"Workflow created, but dispatch failed.");return;}
    window.location.href="/runs?task="+encodeURIComponent(b.task.id);
  }

  return <OrchestraShell title="Workflow Studio" section="Workflow Studio"><div className="studioShell">
    <section className="studioHero">
      <div><div className="pill">AI-FIRST WORKFLOW DESIGN</div><h2>Describe the outcome. Shape the orchestration. Run it.</h2><p className="muted">Start in natural language, then use the visual editor only where you need control. The same validated plan is sent to the production queue.</p></div>
      <button className="studioRunButton" type="button" onClick={runWorkflow} disabled={busy}>{busy?"Preparing…":"Run workflow →"}</button>
    </section>

    <section className="studioGoal card">
      <label htmlFor="studio-goal">What should Orchestra accomplish?</label>
      <textarea id="studio-goal" value={goal} onChange={e=>setGoal(e.target.value)} placeholder="Example: Research the Indian SaaS market, compare 8 competitors, identify the strongest opportunities, and give me a decision-ready table." />
      <div className="studioGoalHint"><span>Natural-language planning</span><span>{goal.length}/2000</span></div>
    </section>

    <section className="studioGrid">
      <div className="card studioEditor">
        <div className="studioSectionHead"><div><div className="sectionTitle">Visual workflow</div><div className="muted small">Drag stages to reorganize. Use the dependency field when order alone is not enough.</div></div><button className="secondary" type="button" onClick={addStep}>＋ Add stage</button></div>

        <div className="studioFlow">
          {steps.map((step,index)=>{
            const agent=agentMap.get(step.agentId);
            const isSelected=step.id===activeStep?.id;
            return <article key={step.id} draggable onDragStart={()=>setDragId(step.id)} onDragOver={e=>e.preventDefault()} onDrop={()=>{reorder(dragId,step.id);setDragId("")}} onClick={()=>setSelected(step.id)} className={"studioNode "+(isSelected?"selected":"")}>
              <div className="studioNodeRail"><span>{index+1}</span></div>
              <div className="studioNodeMain">
                <div className="studioNodeHeader"><strong>{agent?.name??pretty(step.agentId)}</strong><span>{step.kind==="verification"?"VERIFY":"WORK"}</span></div>
                <div className="studioNodeTitle">{step.objective}</div>
                <div className="studioNodeMeta"><span>{step.dependsOn.length?("Depends on "+step.dependsOn.map(pretty).join(", ")): "Independent stage"}</span><span>Drag ↕</span></div>
              </div>
              <div className="studioNodeActions">
                <button type="button" title="Move up" onClick={e=>{e.stopPropagation();move(step.id,-1)}}>↑</button>
                <button type="button" title="Move down" onClick={e=>{e.stopPropagation();move(step.id,1)}}>↓</button>
                {steps.length>5&&step.kind!=="verification"&&<button type="button" title="Remove stage" onClick={e=>{e.stopPropagation();removeStep(step.id)}}>×</button>}
              </div>
            </article>
          })}
        </div>
      </div>

      <aside className="card studioInspector">
        <div className="sectionTitle">Stage controls</div>
        {!activeStep?<div className="empty">Select a stage.</div>:<>
          <label>Stage name<input value={activeStep.id} onChange={e=>updateStep(activeStep.id,{id:slug(e.target.value)})}/></label>
          <label>Agent<select value={activeStep.agentId} onChange={e=>updateStep(activeStep.id,{agentId:e.target.value})}>{agents.map(a=><option key={a.id} value={a.id} disabled={a.status==="offline"}>{a.name}{a.status==="offline"?" · offline":""}</option>)}</select></label>
          <label>Objective<textarea value={activeStep.objective} onChange={e=>updateStep(activeStep.id,{objective:e.target.value})}/></label>
          <label>Dependencies<select multiple value={activeStep.dependsOn} onChange={e=>updateStep(activeStep.id,{dependsOn:Array.from(e.target.selectedOptions).map(o=>o.value).filter(v=>v!==activeStep.id)})}>{steps.filter(s=>s.id!==activeStep.id && s.kind!=="verification").map(s=><option key={s.id} value={s.id}>{pretty(s.id)}</option>)}</select></label>
          <label>Attempts<input type="number" min={1} max={5} value={activeStep.maxAttempts} onChange={e=>updateStep(activeStep.id,{maxAttempts:Math.min(5,Math.max(1,Number(e.target.value)||1))})}/></label>
          <div className="studioInspectorNote">Governance remains server-side. The editor can shape the workflow, but it cannot grant tools, permissions, connector authority or bypass verification.</div>
        </>}
      </aside>
    </section>

    {message&&<div className="friendlyMessage" role="status">{message}</div>}
  </div></OrchestraShell>
}
