"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function Login() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("error")) {
      setState("error");
      setMsg("That sign-in link expired or was already used. Request a new one.");
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setMsg("");
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setState("error");
      setMsg("That email isn't on the invite list, or the link couldn't be sent. Check the address or ask Tobi for an invite.");
    } else {
      setState("sent");
      setMsg(`Sign-in link sent to ${email.trim()}. Open it on this device.`);
    }
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand"><span className="brand-mark" aria-hidden="true"></span>Redraft</div>
        <h1>Sign in</h1>
        <p>Invite only. Enter your email and we&apos;ll send you a sign-in link.</p>
        <label htmlFor="email" className="hint">Email</label>
        <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn primary" disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Send sign-in link"}</button>
        {msg && <div className={`login-msg ${state === "sent" ? "ok" : "err"}`} role="status">{msg}</div>}
      </form>
    </main>
  );
}
