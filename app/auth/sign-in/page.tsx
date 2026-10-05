"use client";

import { useState, type FormEvent, type ReactNode, type ChangeEvent } from "react";
import { createClient } from "@/lib/supabase/browser";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage("Signing in…");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setMessage(error.message);
    else window.location.href = "/";
  }

  return <AuthShell title="Sign in"><form onSubmit={submit} className="stack"><input required type="email" placeholder="Email" value={email} onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} /><input required type="password" placeholder="Password" value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} /><button type="submit">Sign in</button><div className="muted">{message}</div><a href="/auth/sign-up">Create an account</a></form></AuthShell>;
}

function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return <main className="auth"><div className="card authCard"><div className="authBrand"><span className="brandMark">A</span><span>AI Orchestra</span></div><h1>{title}</h1>{children}</div></main>;
}
