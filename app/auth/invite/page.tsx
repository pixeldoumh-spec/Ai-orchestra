"use client";

import { useState, type FormEvent } from "react";

export default function InvitationPage(){
 const [token,setToken]=useState("");
 const [message,setMessage]=useState("");
 const [busy,setBusy]=useState(false);
 async function submit(e:FormEvent){
  e.preventDefault(); if(!token.trim())return;
  setBusy(true);setMessage("Joining workspace…");
  const r=await fetch("/api/enterprise/invitations/accept",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:token.trim()})});
  const b=await r.json().catch(()=>({}));
  if(!r.ok){setMessage(b.error??"Invitation could not be accepted");setBusy(false);return;}
  window.location.href="/enterprise";
 }
 return <main className="auth"><div className="card authCard">
  <div className="authBrand"><span className="brandMark">A</span><span>AI Orchestra</span></div>
  <h1>Join a workspace</h1>
  <p className="muted small">Paste the one-time invitation token you received. You must be signed in with the invited email address.</p>
  <form onSubmit={submit} className="stack">
   <input required minLength={20} maxLength={200} value={token} onChange={e=>setToken(e.target.value)} placeholder="Invitation token" autoComplete="one-time-code"/>
   <button type="submit" disabled={busy||token.trim().length<20}>{busy?"Joining…":"Accept invitation"}</button>
   {message&&<div className="muted small">{message}</div>}
   <a href="/">Back to Orchestra</a>
  </form>
 </div></main>;
}
