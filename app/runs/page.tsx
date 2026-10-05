"use client";

import { useEffect, useState } from "react";
import { OrchestraShell } from "@/components/OrchestraShell";

type Task=any;

export default function RunsPage(){
  const [tasks,setTasks]=useState<Task[]>([]);
  const [selected,setSelected]=useState<Task|null>(null);
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState("");
  const [comment,setComment]=useState("");
  const [comments,setComments]=useState<any[]>([]);
  const [evidence,setEvidence]=useState<any[]>([]);

  async function load(){
    const r=await fetch("/api/tasks?limit=80");
    const b=await r.json().catch(()=>({}));
    if(!r.ok){setMessage(b.error??"Run history unavailable");return;}
    setTasks(b.tasks??[]);
    const requested = new URLSearchParams(window.location.search).get("task");
    if(!selected && requested && (b.tasks??[]).some((t:any)=>t.id===requested)){ await selectTask(requested); return; }
    if(selected){
      const d=await fetch("/api/tasks/"+encodeURIComponent(selected.id));
      if(d.ok) setSelected((await d.json()).task??null);
    }else if((b.tasks??[]).length) setSelected(b.tasks[0]);
  }

  async function selectTask(id:string){
    setBusy("load");
    const r=await fetch("/api/tasks/"+encodeURIComponent(id));
    const b=await r.json().catch(()=>({}));
    setBusy("");
    if(!r.ok){setMessage(b.error??"Could not open run");return;}
    setSelected(b.task);
  }

  useEffect(()=>{void load();},[]);

  useEffect(()=>{
    if(!selected?.id) return;
    let live=true;
    void Promise.all([
      fetch("/api/evidence?taskId="+encodeURIComponent(selected.id)),
      fetch("/api/tasks/"+encodeURIComponent(selected.id)+"/comments"),
    ]).then(async ([er,cr])=>{
      const [e,c]=await Promise.all([er.json().catch(()=>({})),cr.json().catch(()=>({}))]);
      if(live){setEvidence(e.evidence??[]);setComments(c.comments??[]);}
    }).catch(()=>{});
    if(!["verified","failed","cancelled"].includes(selected.status)){
      const s=new EventSource("/api/tasks/"+encodeURIComponent(selected.id)+"/stream");
      s.addEventListener("execution",(ev)=>{
        try{const p=JSON.parse((ev as MessageEvent<string>).data);if(p.task){setSelected(p.task);setTasks(old=>old.map(t=>t.id===p.task.id?{...t,status:p.task.status,spent_cost_cents:p.task.spent_cost_cents,updated_at:p.task.updated_at}:t));}}
        catch{}
      });
      return ()=>{live=false;s.close();};
    }
    return ()=>{live=false;};
  },[selected?.id]);

  const currentRevision = selected?.plan_revision ?? 1;
  const currentSteps = (selected?.steps ?? []).filter((s:any) => s.plan_revision === currentRevision);

  async function start(){
    if(!selected) return;
    setBusy("start");
    const r=await fetch("/api/tasks/"+selected.id+"/start",{method:"POST"});
    const b=await r.json().catch(()=>({}));
    setBusy("");
    if(!r.ok){setMessage(b.error??"Could not start run");return;}
    setSelected(b.task??selected);
    await load();
  }

  async function resolve(approvalId:string,decision:"approve"|"reject"){
    if(!selected)return;
    setBusy(decision);
    const r=await fetch("/api/tasks/"+selected.id+"/approve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({approvalId,decision})});
    const b=await r.json().catch(()=>({}));
    setBusy("");
    if(!r.ok){setMessage(b.error??"Approval could not be resolved");return;}
    const d=await fetch("/api/tasks/"+selected.id);
    if(d.ok)setSelected((await d.json()).task??selected);
  }

  async function addComment(){
    if(!selected||!comment.trim())return;
    setBusy("comment");
    const r=await fetch("/api/tasks/"+selected.id+"/comments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({body:comment})});
    const b=await r.json().catch(()=>({}));
    setBusy("");
    if(!r.ok){setMessage(b.error??"Comment failed");return;}
    setComments(old=>[...old,b.comment]);setComment("");
  }

  return <OrchestraShell title="Runs" section="Runs"><div className="runsLayout">
    <section className="runsList card">
      <div className="runsListHeader">
        <div><div className="sectionTitle">Run history</div><div className="muted small">Every orchestration run stays addressable after the chat is closed.</div></div>
        <button className="secondary" onClick={()=>void load()} disabled={busy==="load"}>{busy==="load"?"Refreshing…":"Refresh"}</button>
      </div>
      {message&&<div className="friendlyMessage">{message}</div>}
      {tasks.length===0?<div className="empty">No runs yet. Start one from Home.</div>:tasks.map((t)=>(
        <button type="button" key={t.id} className={"runListItem "+(selected?.id===t.id?"selected":"")} onClick={()=>void selectTask(t.id)}>
          <div className="runListMain"><strong>{t.goal}</strong><span>{t.id} · {formatStatus(t.status)}</span></div>
          <div className="runListMeta"><span>{t.spent_cost_cents??0}¢</span><span>{formatDate(t.created_at)}</span></div>
        </button>
      ))}
    </section>

    <section className="runDetail card">
      {!selected?<div className="empty">Select a run to inspect its execution, approval state and evidence.</div>:<>
        <div className="runDetailHeader">
          <div><div className="runEyebrow">RUN DETAIL</div><h2>{selected.goal}</h2><div className="runMeta">{selected.id} · {selected.execution_region??"policy assigned"} · revision {selected.plan_revision??1}</div></div>
          <span className={"runState "+selected.status}><span className="stateDot"/>{formatStatus(selected.status)}</span>
        </div>

        <div className="runActions">
          {["queued","running"].includes(selected.status)&&<button onClick={()=>void start()} disabled={busy==="start"}>{busy==="start"?"Starting…":"Start / Resume"}</button>}
          <a className="secondary actionLink" href="/">Open composer</a>
        </div>

        <div className="executionTimeline">
          {currentSteps.map((s:any,i:number)=>(
            <div className="executionStep" key={s.id}>
              <div className={"stepMarker "+s.status}>{["verified","succeeded","completed"].includes(s.status)?"✓":i+1}</div>
              <div className="stepDetails"><div className="stepLine"><strong>{pretty(s.agent_id)}</strong><span>{formatStatus(s.status)}</span></div><div className="stepObjective">{s.objective}</div><div className="stepTrack"><span style={{width:stepWidth(s.status)}}/></div></div>
            </div>
          ))}
        </div>

        {(selected.approvals??[]).filter((a:any)=>a.status==="pending").map((a:any)=><div className="approvalNotice" key={a.id}><div className="approvalCopy"><strong>Approval required</strong><span>{a.reason}</span></div><div className="approvalActions"><button disabled={busy==="approve"} onClick={()=>void resolve(a.id,"approve")}>Approve</button><button className="quietButton" disabled={busy==="reject"} onClick={()=>void resolve(a.id,"reject")}>Reject</button></div></div>)}

        {selected.final_result&&<div className="finalResult"><div className="resultHeader"><span>✓ Verified result</span><span>Complete</span></div><pre>{JSON.stringify(selected.final_result,null,2)}</pre></div>}

        {evidence.length>0&&<details className="detailsBlock" open><summary>Evidence · {evidence.length}</summary><div className="detailsContent">{evidence.map((e:any)=><div className="evidenceItem" key={e.id}><div className="evidenceTitle"><strong>{e.source_title??e.source_type}</strong>{e.confidence!=null&&<span>{Math.round(Number(e.confidence)*100)}%</span>}</div>{e.claim&&<p>{e.claim}</p>}{e.source_url&&<a href={e.source_url} target="_blank" rel="noreferrer">Open source</a>}</div>)}</div></details>}

        <details className="detailsBlock" open><summary>Collaboration · {comments.length}</summary><div className="detailsContent">
          {comments.slice(-10).map((c:any)=><div className="commentItem" key={c.id}><strong>{String(c.author_id).slice(0,8)}…</strong><span>{c.body}</span><time>{formatDate(c.created_at)}</time></div>)}
          <div className="commentComposer"><input value={comment} onChange={e=>setComment(e.target.value)} placeholder="Add a note to this run…" onKeyDown={e=>{if(e.key==="Enter")void addComment();}}/><button disabled={!comment.trim()||busy==="comment"} onClick={()=>void addComment()}>Add</button></div>
        </div></details>

        <div className="runFooter"><span>Spend {selected.spent_cost_cents??0}¢ / {selected.max_cost_cents??0}¢</span><span>{currentSteps.length} planned steps</span><span>{executionLabel(selected.status)}</span></div>
      </>}
    </section>
  </div></OrchestraShell>
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

function pretty(v:string){const s=String(v??"specialist").replace(/[_-]+/g," ").trim();return s?s[0].toUpperCase()+s.slice(1):"Specialist"}
function formatStatus(v:string){return String(v??"pending").replace(/[_-]+/g," ").replace(/\b\w/g,c=>c.toUpperCase())}
function stepWidth(v:string){if(["verified","succeeded","completed"].includes(v))return"100%";if(["running","executing","working"].includes(v))return"58%";if(["failed","cancelled","rejected"].includes(v))return"100%";return"8%"}
function formatDate(v:string){try{return new Date(v).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}catch{return v}}
