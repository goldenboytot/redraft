/* ================= Redraft — client app (mounted by components/RedraftApp.tsx) ================= */
import { marked } from "marked";
import DOMPurify from "dompurify";
import * as docxLib from "docx";
import { makeBuilders } from "./builders.js";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uidGen = () => Math.random().toString(36).slice(2, 10);
const MAX_DOC = 60000;
const HISTORY_TURNS = 24;

let supabase = null;
let userId = null;      // signed-in user id; namespaces the local session cache so accounts never mix on a shared browser
let S = freshSession();
let pending = [];          // files waiting in the composer: {name, text}
let busy = null;           // AbortController while Claude is answering
let streamEl = null;
let tab = "resume";
let saveTimer = null, saving = false, saveAgain = false;
let sessionsCache = [];
let pastedN = 0;

function freshSession() {
  return { id: "s_" + Date.now().toString(36) + uidGen(), title: "", docs: [], messages: [], resume: null, cover: null, versions: [],
    keywords: [], confirms: {}, decisions: {}, sentDecisions: {}, fit: null, createdAt: Date.now(), updatedAt: Date.now() };
}

/* ---------- small UI helpers ---------- */
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600); }
function md(text) {
  try { return DOMPurify.sanitize(marked.parse(text || "", { breaks: false, gfm: true, async: false })); } catch (e) {}
  return esc(text).replace(/\n/g, "<br>");
}
function h(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; }

/* ---------- reading uploaded files ---------- */
async function readFile(file) {
  if (/\.(txt|md)$/i.test(file.name)) return await file.text();
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/extract", { method: "POST", body: fd });
  const out = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("You've been signed out. Reload to sign in again.");
  if (!res.ok) throw new Error(out.error || `Couldn't read ${file.name}.`);
  return out.text || "";
}
async function addFiles(list) {
  for (const f of list) {
    try {
      const text = (await readFile(f)).trim();
      if (!text) { toast(`${f.name} has no readable text. If it's a scan, paste the text instead.`); continue; }
      pending.push({ id: "d_" + uidGen(), name: f.name, text: text.slice(0, MAX_DOC) });
    } catch (e) { toast(e.message || `Couldn't read ${f.name}.`); }
  }
  renderPending();
}
function renderPending() {
  const el = $("pending"); el.innerHTML = "";
  pending.forEach((p, i) => {
    const c = h(`<span class="chip">📄 ${esc(p.name)} <span class="hint">${Math.round(p.text.length / 1000)}k chars</span><button class="x" aria-label="Remove ${esc(p.name)}">✕</button></span>`);
    c.querySelector(".x").onclick = () => { pending.splice(i, 1); renderPending(); };
    el.append(c);
  });
}

/* ---------- building what Claude reads ---------- */
function stateBlock() {
  const parts = [];
  const dec = Object.entries(S.decisions);
  if (dec.length) {
    parts.push("CONFIRM DECISIONS SO FAR (binding):\n" + dec.map(([id, d]) => {
      const c = S.confirms[id] || {};
      return `- ${id} [${c.type || "change"}] ${d.status.toUpperCase()}: ${d.status === "approved" ? (d.value || c.proposed) : (c.proposed || "")}${c.where ? " (" + c.where + ")" : ""}`;
    }).join("\n"));
  }
  const open = Object.keys(S.confirms).filter((id) => !S.decisions[id]);
  if (open.length) parts.push("STILL UNDECIDED (do not use yet): " + open.join(", "));
  if (S.resume) parts.push("CURRENT RESUME (latest, includes the user's direct edits; supersedes earlier versions):\n" + JSON.stringify(S.resume));
  if (S.cover) parts.push("CURRENT COVER LETTER:\n" + JSON.stringify(S.cover));
  return parts.length ? "[Current state]\n" + parts.join("\n\n") + "\n\n[User message]\n" : "";
}
function buildInput(latest) {
  const turns = [];
  const hist = S.messages.slice(0, -1).slice(-HISTORY_TURNS);
  for (const m of hist) {
    let content = m.role === "assistant" ? (m.text || "").trim() : (m.text || "").trim();
    if (m.role === "assistant") {
      const bits = [];
      if (m.data?.resume) bits.push("resume");
      if (m.data?.cover) bits.push("cover letter");
      if (m.data?.confirm?.length) bits.push("confirm items " + m.data.confirm.map((c) => c.id).join(", "));
      if (bits.length) content += `\n\n[Sent a data block: ${bits.join("; ")}]`;
    }
    if (!content) continue;
    turns.push({ role: m.role, content });
  }
  turns.push({ role: "user", content: stateBlock() + latest });
  return turns;
}

/* ---------- parsing Claude's reply ---------- */
function splitReply(text) {
  const i = text.lastIndexOf("```data");
  if (i < 0) return { visible: text, raw: null, open: false };
  const rest = text.slice(i + 7);
  const end = rest.indexOf("```");
  return { visible: text.slice(0, i).trimEnd(), raw: end < 0 ? rest : rest.slice(0, end), open: end < 0 };
}
function parseData(raw) {
  if (!raw) return null;
  let s = raw.trim();
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, "$1")); } catch (e) {}
  return undefined;
}
function applyData(d) {
  if (!d || typeof d !== "object") return;
  if (d.title) S.title = String(d.title);
  if (d.fit) S.fit = d.fit;
  if (Array.isArray(d.jd_keywords) && d.jd_keywords.length) S.keywords = d.jd_keywords.filter((k) => k && k.phrase);
  if (Array.isArray(d.confirm)) d.confirm.forEach((c) => { if (c && c.id) S.confirms[c.id] = c; });
  if (d.resume && typeof d.resume === "object") { pushVersion("Before Claude's update"); S.resume = normalizeResume(d.resume); }
  if (d.cover && typeof d.cover === "object") S.cover = { greeting: "", paragraphs: [], signoff: "Sincerely,", ...d.cover };
}
function pushVersion(label) {
  if (!S.resume) return;
  S.versions = [{ at: Date.now(), label, resume: JSON.parse(JSON.stringify(S.resume)) }, ...(S.versions || [])].slice(0, 10);
}
function normalizeResume(r) {
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  return {
    name: r.name || "", headline: r.headline || "", contact: arr(r.contact).map(String),
    summary: arr(r.summary).map(String),
    achievements: arr(r.achievements).map((a) => ({ header: a.header || "", bullets: arr(a.bullets).map(String) })),
    experience: arr(r.experience).map((e) => ({
      title: e.title || "", employer: e.employer || "", location: e.location || "", dates: e.dates || "",
      groups: (Array.isArray(e.groups) && e.groups.length ? e.groups : [{ header: "", bullets: arr(e.bullets) }])
        .map((g) => ({ header: g.header || "", bullets: arr(g.bullets).map(String) })),
    })),
    values: arr(r.values).map((v) => ({ value: v.value || "", line: v.line || "" })),
    skills: arr(r.skills).map((s) => ({ header: s.header || "", items: Array.isArray(s.items) ? s.items.join(", ") : s.items || "" })),
    credentials: arr(r.credentials).map(String), education: arr(r.education).map(String), additional: arr(r.additional).map(String),
  };
}

/* ---------- talking to Claude ---------- */
const ERR = {
  signed_out: "You've been signed out. Reload the page to sign in again, then resend.",
  rate_limited: "Too many requests to Claude right now. Wait a minute, then send again.",
  overloaded: "Claude is busy right now. Send again in a moment.",
  upstream_error: "Something went wrong reaching Claude. Send again.",
};
async function callClaude(turns, { signal, onText, deep }) {
  const res = await fetch("/api/chat", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docs: S.docs.map((d) => ({ name: d.name, text: d.text })), turns, deep }),
  });
  if (res.status === 401) throw { code: "signed_out" };
  if (!res.ok || !res.body) throw { code: "upstream_error" };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      const shown = text.split("\u0000")[0];
      if (shown) onText({ text: shown });
    }
  } catch (e) {
    if (signal.aborted) throw { code: "cancelled", text: text.split("\u0000")[0] };
    throw { code: "upstream_error", text: text.split("\u0000")[0] };
  }
  const [body, meta] = text.split("\u0000");
  if (meta && meta.startsWith("ERROR:")) throw { code: meta.slice(6), text: body };
  return { text: body, truncated: meta === "TRUNCATED" };
}
async function send(text, opts = {}) {
  if (busy) return;
  text = (text || "").trim();
  if (!text && !pending.length) return;
  const files = pending.splice(0);
  renderPending();
  files.forEach((f) => S.docs.push(f));
  let msgText = text || "Here are the documents.";
  if (files.length) msgText += `\n\n[Attached: ${files.map((f) => f.name).join(", ")}]`;
  S.messages.push({ role: "user", text: msgText, display: opts.display || text || "", files: files.map((f) => f.name), at: Date.now() });
  const input = buildInput(msgText);
  const msg = { role: "assistant", text: "", data: null, at: Date.now() };
  S.messages.push(msg);
  busy = new AbortController();
  setBusyUI(true);
  renderLog();
  try {
    const res = await callClaude(input, {
      signal: busy.signal, deep: $("deep").checked,
      onText: ({ text }) => { msg.text = text; renderStreaming(msg); },
    });
    finishReply(msg, res.text, res.truncated);
  } catch (e) {
    const kept = e && e.text ? e.text : "";
    if (e?.code === "cancelled") finishReply(msg, kept || "_Stopped._", false);
    else { finishReply(msg, kept, false); msg.error = ERR[e?.code] || "Something went wrong reaching Claude. Send again."; }
  } finally {
    busy = null; setBusyUI(false); renderAll(); scheduleSave();
  }
}
function finishReply(msg, full, truncated) {
  const { visible, raw, open } = splitReply(full || "");
  msg.text = visible;
  if (raw) {
    const d = parseData(raw);
    if (d === undefined || open) msg.dataError = truncated || open
      ? "The reply was cut off before the document update finished. Ask: \"resend the full resume block\"."
      : "The document update couldn't be read. Ask: \"resend the data block\".";
    else { msg.data = d; applyData(d); }
  }
  if (truncated && !msg.dataError) msg.error = "The reply was cut short. Ask for less at a time.";
}
function setBusyUI(on) {
  $("send").textContent = on ? "Stop" : "Send";
  $("send").classList.toggle("primary", !on);
  $("attach").disabled = on;
}

/* ---------- rendering the conversation ---------- */
function renderLog() {
  const log = $("log"); log.innerHTML = "";
  if (!S.messages.length) { log.append(welcome()); renderQuick(); return; }
  S.messages.forEach((m, i) => log.append(renderMsg(m, i)));
  log.scrollTop = log.scrollHeight;
  renderQuick();
}
function welcome() {
  return h(`<div class="welcome">
    <h1>Tailor a CV to one job, in conversation.</h1>
    <p>Same flow as the chats that landed the GoA Business Lead and IMAP Lead offers. Claude reads both documents, asks what it needs, and builds the resume beside this chat. Nothing beyond the CV goes in until you approve it.</p>
    <ol class="flow">
      <li><span><b>Attach the CV</b> and paste or attach the job description.</span></li>
      <li><span><b>Review the analysis.</b> Fit score, strategy and clarifying questions.</span></li>
      <li><span><b>Answer and approve.</b> Title changes, reframes, tools or figures each get a confirm.</span></li>
      <li><span><b>Iterate.</b> Ask for changes in chat or edit the page directly.</span></li>
      <li><span><b>Download</b> the Word resume, then the cover letter written from it.</span></li>
    </ol>
  </div>`);
}
function renderMsg(m, i) {
  const wrap = h(`<div class="msg ${m.role}"></div>`);
  wrap.append(h(`<div class="who">${m.role === "user" ? "You" : "Claude"}</div>`));
  if (m.role === "user") {
    const shown = m.display ?? m.text;
    if (shown) wrap.append(h(`<div class="bubble">${esc(shown)}</div>`));
    if (m.files?.length) wrap.append(h(`<div class="chips">${m.files.map((f) => `<span class="chip">📄 ${esc(f)}</span>`).join("")}</div>`));
    return wrap;
  }
  const isLive = busy && i === S.messages.length - 1;
  const body = h(`<div class="bubble md"></div>`);
  if (isLive) { streamEl = body; paintStream(body, m.text); }
  else body.innerHTML = md(m.text);
  wrap.append(body);
  if (!isLive) {
    const d = m.data || {};
    if (d.fit) wrap.append(fitCard(d.fit));
    if (d.confirm?.length) wrap.append(confirmCard(d.confirm));
    if (d.callouts?.length) wrap.append(calloutCard(d.callouts));
    if (d.resume || d.cover) {
      const u = h(`<div class="updated"></div>`);
      if (d.resume) { const b = h(`<button class="btn">Resume updated · View</button>`); b.onclick = () => showTab("resume"); u.append(b); }
      if (d.cover) { const b = h(`<button class="btn">Cover letter updated · View</button>`); b.onclick = () => showTab("cover"); u.append(b); }
      wrap.append(u);
    }
    if (m.dataError) wrap.append(h(`<div class="card"><div class="callout"><span class="pill fix">Fix</span><span>${esc(m.dataError)}</span></div></div>`));
    if (m.error) wrap.append(h(`<div class="card"><div class="callout"><span class="pill fix">Error</span><span>${esc(m.error)}</span></div></div>`));
  }
  return wrap;
}
function paintStream(el, text) {
  const { visible, raw } = splitReply(text || "");
  if (!text) { el.innerHTML = `<div class="thinking"><span class="dot"></span>Reading and thinking. First replies can take up to a minute.</div>`; return; }
  el.innerHTML = md(visible) + (raw !== null ? `<p class="updating">Updating documents…</p>` : "");
}
function renderStreaming(m) {
  if (!streamEl) return renderLog();
  paintStream(streamEl, m.text);
  const log = $("log");
  if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = log.scrollHeight;
}
function fitCard(f) {
  const v = ["strong", "reframe", "stretch"].includes(f.verdict) ? f.verdict : "reframe";
  return h(`<div class="card fit"><div class="score">${esc(f.score ?? "–")}<small>/10</small></div>
    <div><span class="pill ${v}">${esc(v)}</span><div style="margin-top:6px">${esc(f.summary || "")}</div></div></div>`);
}
function calloutCard(list) {
  const c = h(`<div class="card"><h4>Callouts</h4></div>`);
  list.forEach((x) => {
    const sev = ["fix", "verify", "consider"].includes(x.severity) ? x.severity : "consider";
    c.append(h(`<div class="callout"><span class="pill ${sev}">${sev}</span><span>${esc(x.text)}</span></div>`));
  });
  return c;
}
function confirmCard(list) {
  const c = h(`<div class="card"><h4>Confirm before use</h4></div>`);
  list.forEach((item) => {
    const live = S.confirms[item.id] || item;
    const dec = S.decisions[item.id];
    const status = dec ? dec.status : "pending";
    const row = h(`<div class="confirm-row">
      <div class="confirm-head"><span class="pill type">${esc(live.type || "change")}</span>${live.where ? `<span>${esc(live.where)}</span>` : ""}<span class="pill ${status}">${status}</span></div>
      <div class="change">${live.current ? `<span>Now</span><span class="was">${esc(live.current)}</span>` : ""}<span>Change</span><span class="prop">${esc(dec?.value || live.proposed || "")}</span></div>
      ${live.why ? `<div class="why">${esc(live.why)}</div>` : ""}
      <div class="row-actions"></div></div>`);
    const acts = row.querySelector(".row-actions");
    const mk = (label, fn, cls = "") => { const b = h(`<button class="btn ${cls}">${label}</button>`); b.onclick = fn; acts.append(b); };
    mk("Approve", () => decide(item.id, "approved"), status === "approved" ? "primary" : "");
    mk("Edit", () => {
      if (row.querySelector(".edit-input")) return;
      const inp = h(`<input class="edit-input" id="edit_${esc(item.id)}" aria-label="Edit the proposed change">`);
      inp.value = dec?.value || live.proposed || "";
      const ok = h(`<button class="btn primary">Approve edited</button>`);
      ok.onclick = () => decide(item.id, "approved", inp.value.trim());
      row.insertBefore(inp, acts); acts.append(ok); inp.focus();
    });
    mk("Reject", () => decide(item.id, "rejected"), status === "rejected" ? "primary" : "");
    c.append(row);
  });
  const unsent = list.filter((x) => S.decisions[x.id] && S.sentDecisions[x.id] !== JSON.stringify(S.decisions[x.id]));
  const left = list.filter((x) => !S.decisions[x.id]).length;
  const foot = h(`<div class="row-actions" style="border-top:1px solid var(--line);padding-top:10px;align-items:center"></div>`);
  const sendB = h(`<button class="btn primary" ${unsent.length ? "" : "disabled"}>Send ${unsent.length || ""} decision${unsent.length === 1 ? "" : "s"}</button>`);
  sendB.onclick = () => sendDecisions(list);
  foot.append(sendB);
  if (left) foot.append(h(`<span class="hint">${left} still pending. Pending items stay out of the resume.</span>`));
  c.append(foot);
  return c;
}
function decide(id, status, value) {
  S.decisions[id] = { status, ...(value ? { value } : {}) };
  renderLog(); scheduleSave();
}
function sendDecisions(list) {
  const lines = list.filter((x) => S.decisions[x.id] && S.sentDecisions[x.id] !== JSON.stringify(S.decisions[x.id])).map((x) => {
    const d = S.decisions[x.id];
    S.sentDecisions[x.id] = JSON.stringify(d);
    return `- ${x.id} (${x.type}${x.where ? ", " + x.where : ""}): ${d.status.toUpperCase()}${d.status === "approved" ? ` → "${d.value || x.proposed}"` : ""}`;
  });
  if (!lines.length) return;
  const txt = "My decisions on the proposed changes:\n" + lines.join("\n") + (S.resume ? "\nUpdate the resume to match." : "");
  send(txt, { display: "Decisions:\n" + lines.join("\n") });
}

/* ---------- quick actions ---------- */
function renderQuick() {
  const q = $("quick"); q.innerHTML = "";
  if (busy) return;
  const acts = [];
  if (S.docs.length && !S.resume) {
    acts.push(["Analyse CV against the job", "Analyse the CV against the job description. Give the fit score, strategy, your clarifying questions and anything that needs my confirmation. Don't build yet."]);
    acts.push(["Build the resume now", "Build the full resume now using the method. Put anything beyond the CV in the confirm list and leave it out until I approve."]);
  }
  if (S.resume) {
    acts.push(["Tighten bullets", "Tighten the bullets without dropping any job description phrases. Update the resume."]);
    acts.push(["Final check", "Run a final check before I submit: consistency (dates, titles, locations), grammar, keyword coverage, seniority verbs, anything that needs verifying. List issues as callouts and fix the safe ones in the resume."]);
    acts.push(["Write cover letter", "The resume is final. Write the cover letter from it, following the cover letter rules."]);
    acts.push(["Recruiter message", "Write a short message-to-recruiter (2-3 punchy sentences) with two differentiators that aren't obvious from the resume. Return it in chat and include it as cover.recruiter_note."]);
  }
  if (S.messages.length) acts.push(["Weigh outside feedback", null]);
  acts.forEach(([label, prompt]) => {
    const b = h(`<button>${esc(label)}</button>`);
    b.onclick = () => {
      if (!prompt) { const box = $("box"); box.value = "Here's outside feedback. Assess each point (apply / skip / already done, one-line reason), then apply the valid ones:\n\n" + box.value; box.focus(); grow(); return; }
      send(prompt, { display: label });
    };
    q.append(b);
  });
}

/* ---------- documents pane ---------- */
function showTab(t) {
  tab = t;
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  if (window.matchMedia("(max-width: 960px)").matches) setView("docs");
  renderDocs();
}
function renderDocs() {
  $("kwCount").textContent = S.keywords.length ? String(S.keywords.length) : "";
  $("fileCount").textContent = S.docs.length ? String(S.docs.length) : "";
  const body = $("docbody"); body.innerHTML = "";
  if (tab === "resume") renderResumeTab(body);
  else if (tab === "cover") renderCoverTab(body);
  else if (tab === "keywords") renderKeywordsTab(body);
  else renderFilesTab(body);
}
function editable(text, path, tag = "span", cls = "") {
  const v = String(text ?? "");
  const marked = esc(v).replace(/\[ADD FIGURE\]/g, "<mark>[ADD FIGURE]</mark>");
  return `<${tag} class="${cls}" contenteditable="true" spellcheck="true" data-path="${path}">${marked}</${tag}>`;
}
function setPath(obj, path, val) {
  const ks = path.split(".");
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[isNaN(ks[i]) ? ks[i] : +ks[i]];
  o[isNaN(ks.at(-1)) ? ks.at(-1) : +ks.at(-1)] = val;
}
function removePath(obj, path) {
  const ks = path.split(".");
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[isNaN(ks[i]) ? ks[i] : +ks[i]];
  o.splice(+ks.at(-1), 1);
}
function wireEditing(root, target, rerender) {
  root.querySelectorAll("[data-path]").forEach((el) => {
    el.addEventListener("input", () => { setPath(target(), el.dataset.path, el.innerText.replace(/\s*\n\s*/g, " ").trim()); scheduleSave(); });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
  });
  root.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { removePath(target(), b.dataset.rm); scheduleSave(); rerender(); }));
}
function checksFor(r) {
  const out = [];
  const all = JSON.stringify(r);
  const figs = (all.match(/\[ADD FIGURE\]/g) || []).length;
  out.push(figs ? ["bad", `${figs} × [ADD FIGURE] to fill`] : ["ok", "No figure placeholders"]);
  const sw = r.summary.join(" ").split(/\s+/).filter(Boolean).length;
  out.push([sw >= 80 && sw <= 150 ? "ok" : "warn", `Summary ${sw} words`]);
  if (/^\s*(results[- ]driven|dynamic|seasoned)/i.test(r.summary[0] || "")) out.push(["bad", "Summary opens with a stock phrase"]);
  const dateRx = /^[A-Z][a-z]{2,8}\.? \d{4} – ([A-Z][a-z]{2,8}\.? \d{4}|Present)$/;
  const badDates = r.experience.filter((e) => e.dates && !dateRx.test(e.dates.trim())).length;
  out.push(badDates ? ["warn", `${badDates} date${badDates > 1 ? "s" : ""} off format`] : ["ok", "Dates consistent"]);
  const ach = r.achievements.length;
  out.push([ach >= 3 && ach <= 4 ? "ok" : "warn", `${ach} achievement blocks`]);
  const cov = coverage();
  if (cov.total) out.push([cov.pct >= 75 ? "ok" : cov.pct >= 55 ? "warn" : "bad", `Keywords ${cov.pct}%`]);
  return out;
}
function renderResumeTab(body) {
  const r = S.resume;
  if (!r) { body.append(h(`<div class="empty">The tailored resume appears here once Claude builds it. You can edit any line directly on the page.</div>`)); return; }
  const bar = h(`<div class="toolbar"><div class="checks"></div><span class="spacer"></span><select class="btn" id="versions" aria-label="Earlier versions"><option value="">Earlier versions (${(S.versions || []).length})</option></select><button class="btn primary" id="dlResume">Download .docx</button></div>`);
  checksFor(r).forEach(([k, t]) => bar.querySelector(".checks").append(h(`<span class="check ${k}">${esc(t)}</span>`)));
  const sel = bar.querySelector("#versions");
  (S.versions || []).forEach((v, i) => sel.append(new Option(`${new Date(v.at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })} · ${v.label}`, String(i))));
  sel.disabled = !(S.versions || []).length;
  sel.onchange = () => {
    const i = sel.value; if (i === "") return;
    const v = S.versions[+i];
    S.versions.splice(+i, 1);
    pushVersion("Before restoring an earlier version");
    S.resume = normalizeResume(v.resume);
    renderDocs(); scheduleSave(); toast("Restored. Claude will see this version on your next message.");
  };
  bar.querySelector("#dlResume").onclick = () => download("resume");
  body.append(bar);
  let x = `<article class="sheet">`;
  x += editable(r.name, "name", "div", "nm") + editable(r.headline, "headline", "div", "hl");
  x += `<div class="ct">${r.contact.map((c, i) => editable(c, "contact." + i)).join(" &nbsp;|&nbsp; ")}</div>`;
  if (r.summary.length) { x += `<div class="sh">Professional Summary</div>` + r.summary.map((p, i) => editable(p, "summary." + i, "p")).join(""); }
  if (r.achievements.length) {
    x += `<div class="sh">Key Achievements</div>`;
    r.achievements.forEach((a, i) => { x += editable(a.header, `achievements.${i}.header`, "div", "ah") + `<ul>${a.bullets.map((b, j) => li(b, `achievements.${i}.bullets.${j}`)).join("")}</ul>`; });
  }
  if (r.experience.length) {
    x += `<div class="sh">Professional Experience</div>`;
    r.experience.forEach((e, i) => {
      x += editable(e.title, `experience.${i}.title`, "div", "jt");
      x += `<div class="jm">${editable(e.employer, `experience.${i}.employer`)} &nbsp;|&nbsp; ${editable(e.location, `experience.${i}.location`)} &nbsp;|&nbsp; ${editable(e.dates, `experience.${i}.dates`)}</div>`;
      e.groups.forEach((g, gi) => {
        if (g.header) x += editable(g.header, `experience.${i}.groups.${gi}.header`, "div", "gh");
        x += `<ul>${g.bullets.map((b, j) => li(b, `experience.${i}.groups.${gi}.bullets.${j}`)).join("")}</ul>`;
      });
    });
  }
  if (r.values.length) { x += `<div class="sh">Values Alignment</div><ul>` + r.values.map((v, i) => `<li><b>${editable(v.value, `values.${i}.value`)}:</b> ${editable(v.line, `values.${i}.line`)}</li>`).join("") + `</ul>`; }
  if (r.skills.length) { x += `<div class="sh">Skills</div>` + r.skills.map((s, i) => `<p><b>${editable(s.header, `skills.${i}.header`)}:</b> ${editable(s.items, `skills.${i}.items`)}</p>`).join(""); }
  const list = (name, key) => r[key].length ? `<div class="sh">${name}</div><ul>${r[key].map((c, i) => li(c, `${key}.${i}`)).join("")}</ul>` : "";
  x += list("Certifications", "credentials") + list("Education", "education") + list("Additional Information", "additional");
  x += `</article><p class="note">Click any line to edit it. Claude sees your edits on the next message. Preview set in Carlito, a metric match for Calibri; the download uses Calibri.</p>`;
  const wrap = h(`<div>${x}</div>`);
  wireEditing(wrap, () => S.resume, renderDocs);
  body.append(wrap);
}
function li(text, path) { return `<li>${editable(text, path)}<button class="rm" data-rm="${path}" aria-label="Delete this line">✕</button></li>`; }
function renderCoverTab(body) {
  const c = S.cover;
  if (!c) {
    body.append(h(`<div class="empty">Once the resume is final, ask for the cover letter. It's written from the finished resume, five paragraphs, under 400 words.</div>`));
    if (S.resume && !busy) { const b = h(`<button class="btn primary" style="justify-self:center">Write cover letter from this resume</button>`); b.onclick = () => send("The resume is final. Write the cover letter from it, following the cover letter rules.", { display: "Write cover letter" }); body.append(b); }
    return;
  }
  const words = (c.paragraphs || []).join(" ").split(/\s+/).filter(Boolean).length;
  const bar = h(`<div class="toolbar"><div class="checks"><span class="check ${words <= 400 ? "ok" : "bad"}">${words} words</span><span class="check ${c.paragraphs.length === 5 ? "ok" : "warn"}">${c.paragraphs.length} paragraphs</span>${/i am writing to express/i.test(c.paragraphs[0] || "") ? `<span class="check bad">Stock opener</span>` : ""}</div><span class="spacer"></span><button class="btn primary" id="dlCover">Download .docx</button></div>`);
  bar.querySelector("#dlCover").onclick = () => download("cover");
  body.append(bar);
  let x = `<article class="sheet">${editable(c.greeting, "greeting", "p")}`;
  c.paragraphs.forEach((p, i) => (x += editable(p, "paragraphs." + i, "p")));
  x += `<p>${editable(c.signoff, "signoff")}<br>${esc(S.resume?.name || "")}</p></article>`;
  const wrap = h(`<div>${x}</div>`);
  wireEditing(wrap, () => S.cover, renderDocs);
  body.append(wrap);
  if (c.recruiter_note) {
    const n = h(`<div class="card"><h4>Message to recruiter</h4><div>${esc(c.recruiter_note)}</div><div class="row-actions"><button class="btn">Copy</button></div></div>`);
    n.querySelector("button").onclick = async () => { try { await navigator.clipboard.writeText(c.recruiter_note); toast("Copied"); } catch (e) { toast("Select the text and copy it manually."); } };
    body.append(n);
  }
}
const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
function flatResume(r) {
  if (!r) return "";
  return [r.name, r.headline, ...r.summary, ...r.achievements.flatMap((a) => [a.header, ...a.bullets]),
    ...r.experience.flatMap((e) => [e.title, e.employer, ...e.groups.flatMap((g) => [g.header, ...g.bullets])]),
    ...r.values.flatMap((v) => [v.value, v.line]), ...r.skills.flatMap((s) => [s.header, s.items]),
    ...r.credentials, ...r.education, ...r.additional].join(" \n ");
}
function coverage() {
  const rt = norm(flatResume(S.resume)), ct = norm([S.cover?.greeting, ...(S.cover?.paragraphs || [])].join(" "));
  const groups = { resume: [], cover: [], claimable: [], gap: [] };
  S.keywords.forEach((k) => {
    const p = norm(k.phrase);
    if (p && rt.includes(p)) groups.resume.push(k);
    else if (p && ct.includes(p)) groups.cover.push(k);
    else if (k.status === "gap") groups.gap.push(k);
    else groups.claimable.push(k);
  });
  const total = S.keywords.length;
  return { groups, total, inResume: groups.resume.length, pct: total ? Math.round((groups.resume.length / total) * 100) : 0 };
}
function renderKeywordsTab(body) {
  if (!S.keywords.length) { body.append(h(`<div class="empty">Exact job description phrases show up here after the analysis, matched word for word against the resume.</div>`)); return; }
  const cov = coverage();
  const top = h(`<div class="card"><div class="toolbar"><div><div class="stat">${cov.pct}%</div><div class="note">${cov.inResume} of ${cov.total} phrases appear word for word in the resume</div></div><span class="spacer"></span><button class="btn" id="dlReport" ${S.resume ? "" : "disabled"}>Download report</button></div><div class="meter"><i style="width:${cov.pct}%"></i></div></div>`);
  top.querySelector("#dlReport").onclick = () => download("report");
  body.append(top);
  const grp = (title, items, cls) => {
    if (!items.length) return;
    const g = h(`<div class="kwgroup"><h4>${title} · ${items.length}</h4><div class="chips"></div></div>`);
    items.forEach((k) => g.querySelector(".chips").append(h(`<span class="kw ${cls}" title="${esc(k.evidence || "")}">${esc(k.phrase)}</span>`)));
    body.append(g);
  };
  grp("In the resume, exact wording", cov.groups.resume, "in");
  grp("Only in the cover letter", cov.groups.cover, "cv");
  grp("Missing but claimable", cov.groups.claimable, "cv");
  grp("Honest gaps", cov.groups.gap, "out");
  if (cov.groups.claimable.length && S.resume && !busy) {
    const b = h(`<button class="btn" style="justify-self:start">Work the claimable phrases into the resume</button>`);
    b.onclick = () => send("Work these missing job description phrases into the resume word for word where the experience supports them; propose a confirm item for any that need one:\n" + cov.groups.claimable.map((k) => "- " + k.phrase).join("\n"), { display: "Work the claimable phrases into the resume" });
    body.append(b);
  }
}
function renderFilesTab(body) {
  if (!S.docs.length) { body.append(h(`<div class="empty">Attached and pasted documents are listed here. Claude reads all of them on every message.</div>`)); return; }
  S.docs.forEach((d, i) => {
    const c = h(`<div class="card"><div class="toolbar"><b style="overflow-wrap:anywhere">${esc(d.name)}</b><span class="hint">${d.text.length.toLocaleString()} characters</span><span class="spacer"></span><button class="btn">Remove</button></div><details><summary class="hint">Show text</summary><pre style="white-space:pre-wrap;font:12.5px/1.5 var(--f-mono);max-height:320px;overflow:auto">${esc(d.text)}</pre></details></div>`);
    c.querySelector("button").onclick = () => { S.docs.splice(i, 1); renderDocs(); scheduleSave(); };
    body.append(c);
  });
}

/* ---------- downloads ---------- */
function fileBase() {
  const last = (S.resume?.name || "Candidate").split(",")[0].trim().split(/\s+/).pop();
  const role = (S.resume?.headline || S.title || "Role").split(/[—–|-]/)[0].replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).slice(0, 4).join("");
  return `${last}_${role}`.replace(/[^A-Za-z0-9_]/g, "");
}
async function download(kind) {
  try {
    const B = makeBuilders(docxLib);
    let doc, name;
    if (kind === "resume") { doc = B.resume(S.resume); name = fileBase() + "_Resume.docx"; }
    else if (kind === "cover") { doc = B.cover(S.cover, S.resume); name = fileBase() + "_CoverLetter.docx"; }
    else {
      const cov = coverage();
      const flags = S.messages.flatMap((m) => (m.data?.callouts || []).filter((c) => c.severity !== "consider").map((c) => ({ issue: c.text })));
      doc = B.report({ title: S.title || S.resume?.headline || "", ...cov, flags: flags.slice(-12) });
      name = fileBase() + "_KeywordReport.docx";
    }
    const blob = await docxLib.Packer.toBlob(doc);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Downloaded " + name);
  } catch (e) {
    toast("Couldn't create the file. Try again.");
  }
}

/* ---------- sessions (saved to this browser always; synced to Supabase when signed in) ---------- */
const LOCAL_MAX = 30;
function localKey() { return `rr_sessions_${userId || "anon"}`; }
function currentKey() { return `rr_current_session_${userId || "anon"}`; }
function loadLocalSessions() { try { return JSON.parse(localStorage.getItem(localKey()) || "{}"); } catch (e) { return {}; } }
function saveLocalSession(row) {
  try {
    const map = loadLocalSessions();
    map[row.id] = row;
    const ids = Object.keys(map).sort((a, b) => (map[b].updated_at || "").localeCompare(map[a].updated_at || ""));
    for (const id of ids.slice(LOCAL_MAX)) delete map[id];
    localStorage.setItem(localKey(), JSON.stringify(map));
  } catch (e) { /* storage unavailable or full; Supabase sync (if any) still applies */ }
}
function deleteLocalSession(id) {
  try { const map = loadLocalSessions(); delete map[id]; localStorage.setItem(localKey(), JSON.stringify(map)); } catch (e) {}
}
function setCurrentSession(next) {
  S = next;
  try { localStorage.setItem(currentKey(), S.id); } catch (e) {}
}
function serialize() {
  const st = JSON.parse(JSON.stringify(S));
  let json = JSON.stringify(st);
  while (json.length > 900000 && st.messages.length > 6) { st.messages.splice(0, 2); json = JSON.stringify(st); }
  return st;
}
function firstDocName() { return S.docs[0]?.name?.replace(/\.[a-z]+$/i, ""); }
function sessionTitle() { return S.title || S.resume?.headline || firstDocName() || "Untitled session"; }
function scheduleSave() {
  renderTitle();
  if (!S.messages.length) return;
  try { localStorage.setItem(currentKey(), S.id); } catch (e) {}
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 1200);
}
async function doSave() {
  if (saving) { saveAgain = true; return; }
  saving = true;
  try {
    S.updatedAt = Date.now();
    const row = { id: S.id, title: sessionTitle(), state: serialize(), updated_at: new Date().toISOString() };
    saveLocalSession(row);
    if (supabase) {
      const { error } = await supabase.from("sessions").upsert(userId ? { ...row, user_id: userId } : row);
      if (error) toast("Saved in this browser. Couldn't sync to your account — check your connection.");
    }
  } finally { saving = false; if (saveAgain) { saveAgain = false; doSave(); } }
}
async function openSessions() {
  const panel = $("drawerPanel");
  panel.innerHTML = `<div class="toolbar"><h2>Sessions</h2><span class="spacer"></span><button class="btn ghost" id="closeDrawer">Close</button></div><p class="note">Saved in this browser, and to your account when signed in.</p><div id="sessList" class="thinking"><span class="dot"></span>Loading…</div><div class="drawer-footer"><button class="btn ghost" id="signOut">Sign out</button></div>`;
  $("signOut").onclick = async () => { await supabase.auth.signOut(); location.href = "/login"; };
  $("drawer").hidden = false;
  $("closeDrawer").onclick = () => ($("drawer").hidden = true);
  const byId = new Map(Object.values(loadLocalSessions()).map((r) => [r.id, r]));
  if (supabase) {
    const { data, error } = await supabase.from("sessions").select("id,title,updated_at").order("updated_at", { ascending: false }).limit(100);
    if (!error && data) data.forEach((r) => byId.set(r.id, { ...byId.get(r.id), ...r }));
  }
  sessionsCache = [...byId.values()].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  const list = $("sessList"); list.className = ""; list.innerHTML = "";
  list.style.display = "grid"; list.style.gap = "8px";
  if (!sessionsCache.length) list.append(h(`<div class="empty">No saved sessions yet. Sessions save automatically after the first message.</div>`));
  sessionsCache.forEach((row) => {
    const el = h(`<div class="sess ${row.id === S.id ? "current" : ""}"><div class="t">${esc(row.title || "Untitled session")}</div><div class="d">${new Date(row.updated_at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</div><div class="row-actions"><button class="btn">Open</button><button class="btn ghost">Rename</button><button class="btn ghost">Delete</button></div></div>`);
    const [openB, renameB, delB] = el.querySelectorAll("button");
    openB.onclick = async () => {
      if (busy) return;
      openB.disabled = true;
      let state = row.state;
      if (!state && supabase) {
        const { data: one, error: e2 } = await supabase.from("sessions").select("state").eq("id", row.id).single();
        if (e2 || !one) { toast("Couldn't open that session."); openB.disabled = false; return; }
        state = one.state;
      }
      if (!state) { toast("Couldn't open that session."); openB.disabled = false; return; }
      setCurrentSession({ ...freshSession(), ...state, id: row.id });
      $("drawer").hidden = true; renderAll();
    };
    renameB.onclick = async () => {
      const title = await renameSession(row.id, row.title || "Untitled session");
      if (title === null) return;
      row.title = title;
      el.querySelector(".t").textContent = title;
    };
    delB.onclick = async () => {
      if (!delB.dataset.armed) { delB.dataset.armed = "1"; delB.textContent = "Confirm delete"; delB.classList.add("primary"); return; }
      deleteLocalSession(row.id);
      if (supabase) { const { error: e3 } = await supabase.from("sessions").delete().eq("id", row.id); if (e3) toast("Removed from this browser. Couldn't remove it from your account."); }
      el.remove();
      if (row.id === S.id) { setCurrentSession(freshSession()); renderAll(); }
    };
    list.append(el);
  });
}

/* ---------- composer & chrome ---------- */
function grow() { const b = $("box"); b.style.height = "auto"; b.style.height = Math.min(b.scrollHeight, 220) + "px"; }
function renderTitle() { $("sessTitle").textContent = S.messages.length || S.title ? sessionTitle() : "New session"; }
function setView(v) {
  $("panes").dataset.show = v;
  $("segChat").setAttribute("aria-pressed", String(v === "chat"));
  $("segDocs").setAttribute("aria-pressed", String(v === "docs"));
}
function renderAll() { renderLog(); renderDocs(); renderTitle(); }

/** A small centered dialog for naming a session. Resolves the typed name, or null if cancelled. Avoids window.prompt(), which is silently blocked in some embedded/sandboxed views. */
function nameSessionDialog(suggested, opts = {}) {
  const { heading = "Name this session", note = "It's saved so you can come back to it from Sessions.", confirmLabel = "Save" } = opts;
  return new Promise((resolve) => {
    const modal = $("nameModal"), input = $("nameInput");
    modal.querySelector("h2").textContent = heading;
    modal.querySelector(".note").textContent = note;
    $("nameSave").textContent = confirmLabel;
    input.value = suggested || "";
    modal.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 0);
    const done = (val) => {
      modal.hidden = true;
      modal.removeEventListener("click", onBackdrop);
      input.removeEventListener("keydown", onKey);
      $("nameCancel").onclick = null;
      $("nameSave").onclick = null;
      resolve(val);
    };
    const onBackdrop = (e) => { if (e.target === modal) done(null); };
    const onKey = (e) => {
      if (e.key === "Escape") done(null);
      if (e.key === "Enter") done(input.value);
    };
    modal.addEventListener("click", onBackdrop);
    input.addEventListener("keydown", onKey);
    $("nameCancel").onclick = () => done(null);
    $("nameSave").onclick = () => done(input.value);
  });
}

/** Starts a fresh resume rebuild: prompts to name the current chat, saves it (locally and to Supabase), then resets all state. */
async function startNewSession() {
  if (busy) { toast("Wait for the current reply to finish, or stop it, before starting a new one."); return; }
  if (S.messages.length) {
    const name = await nameSessionDialog(sessionTitle(), { note: "It's saved so you can come back to it before you start a new one.", confirmLabel: "Save & start new" });
    if (name === null) return; // cancelled — stay on this chat
    S.title = name.trim() || sessionTitle();
    clearTimeout(saveTimer);
    doSave();
  }
  setCurrentSession(freshSession());
  pending = [];
  tab = "resume";
  renderPending();
  setView("chat");
  renderAll();
  $("box").focus();
}

/** Renames a session (old or the active one) by id: updates the local cache and, if available, Supabase. Returns the saved title, or null if cancelled. */
async function renameSession(id, currentTitle) {
  const name = await nameSessionDialog(currentTitle);
  if (name === null) return null;
  const title = name.trim() || currentTitle;
  if (id === S.id) {
    S.title = title;
    renderTitle();
    clearTimeout(saveTimer);
    await doSave(); // creates the row if it doesn't exist yet, and keeps local + remote in sync
  } else {
    const nowIso = new Date().toISOString();
    try {
      const map = loadLocalSessions();
      if (map[id]) { map[id] = { ...map[id], title, updated_at: nowIso }; localStorage.setItem(localKey(), JSON.stringify(map)); }
    } catch (e) {}
    if (supabase) {
      const { error } = await supabase.from("sessions").update({ title, updated_at: nowIso }).eq("id", id);
      if (error) toast("Renamed in this browser. Couldn't sync the name to your account.");
    }
  }
  return title;
}

let started = false;
export async function init(client) {
  if (started) return;
  started = true;
  supabase = client;
  try {
    const { data } = await supabase.auth.getUser();
    userId = data?.user?.id || null;
  } catch (e) { userId = null; }
  try {
    const lastId = localStorage.getItem(currentKey());
    const row = lastId && loadLocalSessions()[lastId];
    if (row?.state) S = { ...freshSession(), ...row.state, id: lastId };
  } catch (e) {}
  $("send").onclick = () => { if (busy) busy.abort(); else { const v = $("box").value; $("box").value = ""; grow(); send(v); } };
  $("box").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("send").click(); } });
  $("box").addEventListener("input", grow);
  $("box").addEventListener("paste", (e) => {
    const t = e.clipboardData?.getData("text/plain") || "";
    if (t.length > 1500) { e.preventDefault(); pastedN++; pending.push({ id: "d_" + uidGen(), name: `Pasted text ${pastedN}`, text: t.slice(0, MAX_DOC) }); renderPending(); toast("Saved the paste as a document"); }
  });
  $("attach").onclick = () => $("file").click();
  $("file").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  const chatPane = document.querySelector(".chat");
  chatPane.addEventListener("dragover", (e) => { e.preventDefault(); });
  chatPane.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); });
  document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $("segChat").onclick = () => setView("chat");
  $("segDocs").onclick = () => setView("docs");
  $("newBtn").onclick = startNewSession;
  $("sessTitle").onclick = async () => { await renameSession(S.id, sessionTitle()); };
  $("sessionsBtn").onclick = openSessions;
  $("drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") $("drawer").hidden = true; });
  try { $("deep").checked = localStorage.getItem("rr_deep") === "1"; } catch (e) {}
  $("deep").onchange = () => { try { localStorage.setItem("rr_deep", $("deep").checked ? "1" : "0"); } catch (e) {} };

  renderAll();
  $("sessionsBtn").hidden = false;
  $("hint").textContent = "Long pastes (like a job description) are saved as a document automatically.";
}
