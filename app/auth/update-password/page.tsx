"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function UpdatePassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setStatus("error");
      setMsg("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setStatus("error");
      setMsg("Passwords don't match.");
      return;
    }
    setStatus("saving");
    setMsg("");
    const { error } = await supabaseBrowser().auth.updateUser({ password });
    if (error) {
      setStatus("error");
      setMsg("Couldn't update your password. Request a new reset link and try again.");
    } else {
      window.location.assign("/");
    }
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand"><span className="brand-mark" aria-hidden="true"></span>Redraft</div>
        <h1>Set a new password</h1>
        <p>Choose a password you&apos;ll use to sign in.</p>
        <label htmlFor="password" className="hint">New password</label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label htmlFor="confirm" className="hint">Confirm password</label>
        <input
          id="confirm"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button className="btn primary" disabled={status === "saving"}>{status === "saving" ? "Saving…" : "Save password"}</button>
        {msg && <div className="login-msg err" role="status">{msg}</div>}
      </form>
    </main>
  );
}
