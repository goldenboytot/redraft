import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { adminAccess } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 30;

export default async function AdminPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { client, status } = await adminAccess();
  if (status === 401) redirect("/login");
  if (status === 403) notFound();
  if (!client) return <main className="admin-page"><h1>Admin setup required</h1><p>Set SUPABASE_SECRET_KEY on the server to enable the admin view.</p><Link href="/">Back to Redraft</Link></main>;
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.slice(0, 100) : "";
  const owner = typeof params.user === "string" ? params.user : "";
  const completed = params.status === "completed";
  const page = Math.max(1, Math.min(100000, Number(params.page) || 1)) | 0;
  let query = client.from("sessions").select("id,user_id,title,created_at,updated_at,completed_at:state->>completedAt,final_files(count)", { count: "exact" })
    .order("updated_at", { ascending: false }).order("id").range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (q) query = query.ilike("title", `%${q.replace(/[%_\\]/g, "\\$&")}%`);
  if (owner && /^[a-f\d-]{36}$/i.test(owner)) query = query.eq("user_id", owner);
  if (completed) query = query.not("state->>completedAt", "is", null);
  const { data: rows, count, error } = await query;
  const emails = new Map<string, string>();
  await Promise.all([...new Set((rows || []).map((row) => row.user_id))].map(async (id) => {
    const { data } = await client.auth.admin.getUserById(id);
    emails.set(id, data.user?.email || id);
  }));
  const pageUrl = (n: number) => `/admin?${new URLSearchParams({ q, user: owner, status: completed ? "completed" : "all", page: String(n) })}`;
  return <main className="admin-page">
    <header className="toolbar"><div><p className="note">Redraft administration</p><h1>Sessions & outputs</h1></div><span className="spacer"/><nav className="view-mode" aria-label="Account view"><Link className="btn" href="/">User view</Link><Link className="btn" href="/admin" aria-current="page">Admin view</Link></nav></header>
    <p>Review every user’s saved sessions, conversations, and Word files. Users can only access their own records.</p>
    <form className="admin-filters">
      <label>Session title<input name="q" defaultValue={q} placeholder="Search sessions" /></label>
      {owner && <input type="hidden" name="user" value={owner} />}
      <label>Status<select name="status" defaultValue={completed ? "completed" : "all"}><option value="all">All sessions</option><option value="completed">Completed</option></select></label>
      <button className="btn primary">Filter</button><Link className="btn" href="/admin">Reset</Link>
    </form>
    {owner && <p>Showing sessions for {emails.get(owner) || "the selected user"}.</p>}
    <p className="note">Completed means the user saved a resume as final. Click a user to see their sessions.</p>
    {error ? <p role="alert">Couldn’t load sessions. Check the database setup and reload.</p> : <>
      <p>{count || 0} sessions{owner ? " for this user" : " across all users"}</p>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>User</th><th>Session</th><th>Status</th><th>Saved outputs</th><th>Last updated</th></tr></thead>
        <tbody>{(rows || []).map((row) => <tr key={row.id}>
          <td><Link href={`/admin?user=${encodeURIComponent(row.user_id)}`}>{emails.get(row.user_id)}</Link></td>
          <td><Link href={`/admin/sessions/${encodeURIComponent(row.id)}`}>{row.title || "Untitled session"}</Link></td>
          <td><span className={`check ${row.completed_at ? "ok" : "warn"}`}>{row.completed_at ? "Completed" : "In progress"}</span></td>
          <td>{row.final_files?.[0]?.count || 0}</td><td>{new Date(row.updated_at).toLocaleString("en-CA", { timeZone: "UTC" })} UTC</td>
        </tr>)}</tbody>
      </table></div>
      {!rows?.length && <p className="empty">No sessions match these filters.</p>}
      <nav className="toolbar" aria-label="Session pages">{page > 1 && <Link className="btn" href={pageUrl(page - 1)}>Previous</Link>}<span>Page {page}</span>{page * PAGE_SIZE < (count || 0) && <Link className="btn" href={pageUrl(page + 1)}>Next</Link>}</nav>
    </>}
  </main>;
}
