import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { adminAccess } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Render user-provided content as text, never as HTML.
function Output({ value }: { value: unknown }) {
  if (value == null) return null;
  if (Array.isArray(value)) return <div>{value.map((item, i) => <Output key={i} value={item}/>)}</div>;
  if (typeof value === "object") return <dl>{Object.entries(value).map(([key, item]) => <div key={key}><dt>{key.replace(/_/g, " ")}</dt><dd><Output value={item}/></dd></div>)}</dl>;
  return <p className="admin-text">{String(value)}</p>;
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { client, status } = await adminAccess();
  if (status === 401) redirect("/login");
  if (status === 403) notFound();
  if (!client) redirect("/admin");
  const { id } = await params;
  const { data: session, error } = await client.from("sessions").select("*").eq("id", id).maybeSingle();
  if (error) return <main className="admin-page"><Link href="/admin">All sessions</Link><p role="alert">Couldn’t load this session. Please reload.</p></main>;
  if (!session) notFound();
  const [{ data: files, error: fileError }, { data: owner }] = await Promise.all([
    client.from("final_files").select("id,name,kind,size_bytes,created_at").eq("session_id", id).eq("user_id", session.user_id).order("created_at", { ascending: false }),
    client.auth.admin.getUserById(session.user_id),
  ]);
  const state = session.state || {};
  const messages = Array.isArray(state.messages) ? state.messages.filter((message: unknown) => message && typeof message === "object") : [];
  return <main className="admin-page">
    <header className="toolbar"><Link className="btn" href="/admin">All sessions</Link><span className="spacer"/><Link className="btn" href="/">User view</Link></header>
    <h1>{session.title}</h1><p><Link href={`/admin?user=${encodeURIComponent(session.user_id)}`}>{owner.user?.email || session.user_id}</Link> · {state.completedAt ? "Completed" : "In progress"}</p>
    <p className="note">Created {new Date(session.created_at).toISOString()} · Updated {new Date(session.updated_at).toISOString()}</p>
    <section className="card"><h2>Saved outputs</h2>
      {fileError ? <p role="alert">Couldn’t load saved outputs. Check the final-file schema setup.</p> : !files?.length ? <p>No Word files saved yet.</p> :
        <ul className="admin-files">{files.map((file) => <li key={file.id}><a href={`/api/admin/files/${file.id}`}>{file.name}</a><span className="note">{file.kind} · {Math.ceil(file.size_bytes / 1024)} KB · {new Date(file.created_at).toISOString()}</span></li>)}</ul>}
    </section>
    <section className="card"><h2>Current resume</h2>{state.resume ? <Output value={state.resume}/> : <p>No resume generated yet.</p>}</section>
    {state.cover && <section className="card"><h2>Current cover letter</h2><Output value={state.cover}/></section>}
    <section className="card"><h2>Conversation ({messages.length} messages)</h2>{messages.map((message: { role?: string; text?: string; at?: number; error?: string }, i: number) => <article className="admin-message" key={i}>
      <strong>{message.role === "user" ? "User" : "Assistant"}</strong>{message.at && Number.isFinite(new Date(message.at).getTime()) ? <span className="note"> · {new Date(message.at).toISOString()}</span> : null}
      <p className="admin-text">{typeof message.text === "string" ? message.text : ""}</p>{typeof message.error === "string" && message.error && <p role="alert">{message.error}</p>}
    </article>)}</section>
  </main>;
}
