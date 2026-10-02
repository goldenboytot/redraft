"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Mode = "magiclink" | "password" | "forgot";
type Status = "idle" | "sending" | "sent" | "error";

export default function Login() {
  const [mode, setMode] = useState<Mode>("magiclink");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("error")) {
      setStatus("error");
      setMsg("That sign-in link expired or was already used. Request a new one.");
    }
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setStatus("idle");
    setMsg("");
  }

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setMsg("");
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setStatus("error");
      setMsg("That email isn't on the invite list, or the link couldn't be sent. Check the address or ask Tobi for an invite.");
    } else {
      setStatus("sent");
      setMsg(`Sign-in link sent to ${email.trim()}. Open it on this device.`);
    }
  }

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setMsg("");
    const { error } = await supabaseBrowser().auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setStatus("error");
      setMsg("Wrong email or password.");
    } else {
      window.location.assign("/");
    }
  }

  async function sendResetLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setMsg("");
    const { error } = await supabaseBrowser().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/auth/update-password")}`,
    });
    if (error) {
      setStatus("error");
      setMsg("Couldn't send a reset link. Check the address or try again later.");
    } else {
      setStatus("sent");
      setMsg(`Password reset link sent to ${email.trim()}. Open it on this device.`);
    }
  }

  const submit = mode === "magiclink" ? sendMagicLink : mode === "password" ? signInWithPassword : sendResetLink;

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand"><span className="brand-mark" aria-hidden="true"></span>Redraft</div>
        <h1>Sign in</h1>
        <p>
          {mode === "forgot"
            ? "Enter your email and we'll send you a password reset link."
            : "Invite only. Choose how you'd like to sign in."}
        </p>

        {mode !== "forgot" && (
          <div className="login-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "magiclink"}
              className={`login-tab ${mode === "magiclink" ? "active" : ""}`}
              onClick={() => switchMode("magiclink")}
            >
              Sign-in link
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "password"}
              className={`login-tab ${mode === "password" ? "active" : ""}`}
              onClick={() => switchMode("password")}
            >
              Password
            </button>
          </div>
        )}

        <label htmlFor="email" className="hint">Email</label>
        <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />

        {mode === "password" && (
          <>
            <label htmlFor="password" className="hint">Password</label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}

        <button className="btn primary" disabled={status === "sending"}>
          {status === "sending"
            ? mode === "password" ? "Signing in…" : "Sending…"
            : mode === "magiclink" ? "Send sign-in link" : mode === "password" ? "Sign in" : "Send reset link"}
        </button>

        {mode === "password" && (
          <button type="button" className="btn ghost login-link" onClick={() => switchMode("forgot")}>
            Forgot password?
          </button>
        )}
        {mode === "forgot" && (
          <button type="button" className="btn ghost login-link" onClick={() => switchMode("password")}>
            Back to sign in
          </button>
        )}

        {msg && <div className={`login-msg ${status === "sent" ? "ok" : "err"}`} role="status">{msg}</div>}
      </form>
    </main>
  );
}
