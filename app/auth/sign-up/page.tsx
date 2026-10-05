"use client";

import { useState, type FormEvent, type ChangeEvent } from "react";
import { createClient } from "@/lib/supabase/browser";

export default function SignUp() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("My Workspace");
  const [message, setMessage] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage("Creating account…");
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return setMessage(error.message);
    if (!data.session) return setMessage("Account created. Complete email verification, then sign in and create your workspace.");
    const res = await fetch("/api/organizations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: orgName }) });
    const body = await res.json();
    if (!res.ok) return setMessage(body.error ?? "Workspace creation failed");
    window.location.href = "/";
  }

  return <main className="auth"><div className="card authCard"><div className="authBrand"><span className="brandMark">A</span><span>AI Orchestra</span></div><h1>Create account</h1><form onSubmit={submit} className="stack"><input required type="email" placeholder="Email" value={email} onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} /><input required minLength={8} type="password" placeholder="Password (8+ characters)" value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} /><input required placeholder="Workspace name" value={orgName} onChange={(e: ChangeEvent<HTMLInputElement>) => setOrgName(e.target.value)} /><button type="submit">Create workspace</button><div className="muted">{message}</div><a href="/auth/sign-in">Back to sign in</a></form></div></main>;
}
