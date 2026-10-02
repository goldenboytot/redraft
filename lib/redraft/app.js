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
  r = r && typeof r === "object" ? r : {};
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const text = (x) => String(x ?? "");
  const degrees = arr(r.degrees).map((e) => ({
    degree: text(e?.degree), institution: text(e?.institution), year: text(e?.year),
  })).sort((a, b) => {
    const year = (value) => Number(value.match(/\d{4}/)?.[0] || 0);
    return year(b.year) - year(a.year);
  });
  return {
    name: text(r.name).toUpperCase(), contact: arr(r.contact).map(text),
    summary: arr(r.summary).map(text),
    achievements: arr(r.achievements).map((a) => ({ header: text(a?.header), bullets: arr(a?.bullets).map(text) })),
    skills: arr(r.skills).map((s) => ({ label: text(s?.label), items: arr(s?.items).map(text).join(", ") })),
    degrees,
    certifications: arr(r.certifications).map(text),
    experience: arr(r.experience).map((e) => ({
      title: text(e?.title), employer: text(e?.employer), location: text(e?.location), dates: text(e?.dates),
      summary: text(e?.summary), bullets: arr(e?.bullets).map(text),
    })),
    values: arr(r.values).map((v) => ({ value: text(v?.value), line: text(v?.line) })),
    additional: arr(r.additional).map(text),
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
function checksFor(r) {
  const out = [];
  const all = JSON.stringify(r);
  const figs = (all.match(/\[ADD FIGURE\]/g) || []).length;
  out.push(figs ? ["bad", `${figs} × [ADD FIGURE] to fill`] : ["ok", "No figure placeholders"]);
  const sw = r.summary.join(" ").split(/\s+/).filter(Boolean).length;
  out.push([sw >= 120 && sw <= 180 ? "ok" : "warn", `Summary ${sw} words`]);
  if (/^\s*(results[- ]driven|dynamic|seasoned)/i.test(r.summary[0] || "")) out.push(["bad", "Summary opens with a stock phrase"]);
  const dateRx = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} – ((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}|Present)$/;
  const badDates = r.experience.filter((e) => !dateRx.test(e.dates.trim())).length;
  out.push(badDates ? ["warn", `${badDates} date${badDates > 1 ? "s" : ""} off format`] : ["ok", "Dates consistent"]);
  const achievements = r.achievements.length;
  out.push([achievements >= 3 && achievements <= 4 ? "ok" : "warn", `${achievements} achievement blocks`]);
  const cov = coverage();
  if (cov.total) out.push([cov.pct >= 75 ? "ok" : cov.pct >= 55 ? "warn" : "bad", `Keywords ${cov.pct}%`]);
  return out;
}
function renderResumeTab(body) {
  const r = S.resume;
  if (!r) { body.append(h(`<div class="empty">The tailored resume appears here once Claude builds it. Ask for changes in the chat.</div>`)); return; }
  const bar = h(`<div class="toolbar"><div class="checks"></div><span class="spacer"></span><select class="btn" id="versions" aria-label="Earlier versions"><option value="">Earlier versions (${(S.versions || []).length})</option></select><button class="btn" id="saveResume">Save as final</button><button class="btn primary" id="dlResume">Download .docx</button></div>`);
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
  bar.querySelector("#saveResume").onclick = () => download("resume", true);
  body.append(bar);
  const contact = r.contact.filter(Boolean).join("  |  ");
  let x = `<article class="sheet resume-sheet">`;
  x += `<header class="resume-header"><div class="resume-name">${esc(r.name)}</div><div class="resume-contact">${esc(contact)}</div></header><div class="resume-header-rule"></div>`;
  const heading = (title) => `<h3 class="resume-section-heading">${title}</h3>`;
  if (r.summary.length) {
    x += heading("Professional Summary");
    r.summary.forEach((p) => { x += `<p class="resume-summary">${esc(p)}</p>`; });
  }
  if (r.achievements.length) {
    x += heading("Key Achievements");
    r.achievements.forEach((achievement) => {
      x += `<p class="resume-achievement-heading"><b><i>${esc(achievement.header)}</i></b></p>`;
      x += `<ul class="resume-bullets">${achievement.bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join("")}</ul>`;
    });
  }
  if (r.experience.length) {
    x += heading("Professional Experience");
    r.experience.forEach((role, index) => {
      x += `<section class="resume-role${index ? " resume-role-later" : ""}">`;
      x += `<p class="resume-job-title"><b>${esc(role.title)}</b><span>${esc(role.dates)}</span></p>`;
      const employerLine = [role.employer, role.location].filter(Boolean).join(" | ");
      if (employerLine) x += `<p class="resume-employer">${esc(employerLine)}</p>`;
      if (role.summary) x += `<p class="resume-role-summary">${esc(role.summary)}</p>`;
      if (role.bullets.length) {
        x += `<ul class="resume-bullets">${role.bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join("")}</ul>`;
      }
      x += `</section>`;
    });
  }
  if (r.values.length) {
    x += heading("Values Alignment");
    r.values.forEach((value) => { x += `<p class="resume-skill-bullet"><b>${esc(value.value)}: </b>${esc(value.line)}</p>`; });
  }
  if (r.skills.length) {
    x += heading("Skills, Tools & Competencies");
    r.skills.forEach((skill) => {
      x += `<p class="resume-skill-bullet"><b>${esc(skill.label)}: </b>${esc(skill.items)}</p>`;
    });
  }
  if (r.degrees.length || r.certifications.length) {
    x += heading("Education & Certifications");
    r.degrees.forEach((degree) => {
      x += `<p class="resume-degree"><b>${esc(degree.degree)}</b><span>${esc(degree.year)}</span></p>`;
      if (degree.institution) x += `<p class="resume-institution">${esc(degree.institution)}</p>`;
    });
    if (r.certifications.length) {
      x += `<p class="resume-sub-label"><b>Professional Certifications:</b></p>`;
      x += `<ul class="resume-bullets">${r.certifications.map((certification) => `<li>${esc(certification)}</li>`).join("")}</ul>`;
    }
  }
  if (r.additional.length) {
    x += heading("Additional Information");
    x += `<ul class="resume-bullets">${r.additional.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
  }
  x += `</article><p class="note">Preview only. Download the Word file to edit, or ask for changes in the chat.</p>`;
  body.append(h(`<div>${x}</div>`));
}
function renderCoverTab(body) {
  const c = S.cover;
  if (!c) {
    body.append(h(`<div class="empty">Once the resume is final, ask for the cover letter. It's written from the finished resume, five paragraphs, under 400 words.</div>`));
    if (S.resume && !busy) { const b = h(`<button class="btn primary" style="justify-self:center">Write cover letter from this resume</button>`); b.onclick = () => send("The resume is final. Write the cover letter from it, following the cover letter rules.", { display: "Write cover letter" }); body.append(b); }
    return;
  }
  const words = (c.paragraphs || []).join(" ").split(/\s+/).filter(Boolean).length;
  const bar = h(`<div class="toolbar"><div class="checks"><span class="check ${words <= 400 ? "ok" : "bad"}">${words} words</span><span class="check ${c.paragraphs.length === 5 ? "ok" : "warn"}">${c.paragraphs.length} paragraphs</span>${/i am writing to express/i.test(c.paragraphs[0] || "") ? `<span class="check bad">Stock opener</span>` : ""}</div><span class="spacer"></span><button class="btn" id="saveCover">Save as final</button><button class="btn primary" id="dlCover">Download .docx</button></div>`);
  bar.querySelector("#dlCover").onclick = () => download("cover");
  bar.querySelector("#saveCover").onclick = () => download("cover", true);
  body.append(bar);
  const contact = (S.resume?.contact || []).filter(Boolean).join("  |  ");
  let x = `<article class="sheet cover-sheet"><header class="resume-header"><div class="resume-name">${esc(S.resume?.name || "")}</div><div class="resume-contact">${esc(contact)}</div></header><div class="resume-header-rule"></div>`;
  x += `<p>${esc(c.greeting)}</p>`;
  c.paragraphs.forEach((p) => (x += `<p>${esc(p)}</p>`));
  x += `<p>${esc(c.signoff)}<br>${esc(S.resume?.name || "")}</p></article><p class="note">Preview only. Download the Word file to edit, or ask for changes in the chat.</p>`;
  body.append(h(`<div>${x}</div>`));
  if (c.recruiter_note) {
    const n = h(`<div class="card"><h4>Message to recruiter</h4><div>${esc(c.recruiter_note)}</div><div class="row-actions"><button class="btn">Copy</button></div></div>`);
    n.querySelector("button").onclick = async () => { try { await navigator.clipboard.writeText(c.recruiter_note); toast("Copied"); } catch (e) { toast("Select the text and copy it manually."); } };
    body.append(n);
  }
}
const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
function flatResume(r) {
  if (!r) return "";
  return [r.name, ...r.contact, ...r.summary,
    ...r.achievements.flatMap((achievement) => [achievement.header, ...achievement.bullets]),
    ...r.experience.flatMap((role) => [role.title, role.dates, role.employer, role.location, role.summary, ...role.bullets]),
    ...r.values.flatMap((value) => [value.value, value.line]), ...r.skills.flatMap((skill) => [skill.label, skill.items]),
    ...r.degrees.flatMap((degree) => [degree.degree, degree.institution, degree.year]),
    ...r.certifications, ...r.additional].join(" \n ");
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
  const top = h(`<div class="card"><div class="toolbar"><div><div class="stat">${cov.pct}%</div><div class="note">${cov.inResume} of ${cov.total} phrases appear word for word in the resume</div></div><span class="spacer"></span><button class="btn" id="saveReport" ${S.resume ? "" : "disabled"}>Save as final</button><button class="btn" id="dlReport" ${S.resume ? "" : "disabled"}>Download .docx</button></div><div class="meter"><i style="width:${cov.pct}%"></i></div></div>`);
  top.querySelector("#dlReport").onclick = () => download("report");
  top.querySelector("#saveReport").onclick = () => download("report", true);
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
  const sessionId = S.id;
  body.append(h(`<h3>Final files saved to your account</h3>`));
  const finalList = h(`<div class="final-files"><div class="thinking"><span class="dot"></span>Loading saved files…</div></div>`);
  body.append(finalList);
  body.append(h(`<h3>Session documents</h3>`));
  if (!S.docs.length) {
    body.append(h(`<div class="empty">No session documents. Attached and pasted documents are saved as text in this session; original uploads are not retained.</div>`));
  } else {
    S.docs.forEach((d, i) => {
      const c = h(`<div class="card"><div class="toolbar"><b style="overflow-wrap:anywhere">${esc(d.name)}</b><span class="hint">${d.text.length.toLocaleString()} characters</span><span class="spacer"></span><button class="btn">Remove</button></div><details><summary class="hint">Show text</summary><pre style="white-space:pre-wrap;font:12.5px/1.5 var(--f-mono);max-height:320px;overflow:auto">${esc(d.text)}</pre></details></div>`);
      c.querySelector("button").onclick = () => { S.docs.splice(i, 1); renderDocs(); scheduleSave(); };
      body.append(c);
    });
  }

  if (!supabase) {
    finalList.innerHTML = `<div class="empty">Sign in to save final files to your account.</div>`;
    return;
  }
  supabase.from("final_files").select("id,name,kind,storage_path,size_bytes,created_at")
    .eq("session_id", sessionId).order("created_at", { ascending: false })
    .then(({ data, error }) => {
      if (!body.isConnected || S.id !== sessionId) return;
      if (error) {
        finalList.innerHTML = `<div class="empty">Couldn't load saved final files.</div>`;
        toast("Couldn't load saved files. Check your connection.");
        return;
      }
      finalList.innerHTML = "";
      $("fileCount").textContent = S.docs.length + (data?.length || 0) || "";
      if (!data?.length) {
        finalList.append(h(`<div class="empty">None saved yet. Use “Save as final” beside a generated document.</div>`));
        return;
      }
      data.forEach((file) => {
        const card = h(`<div class="card"><div class="toolbar"><b style="overflow-wrap:anywhere">${esc(file.name)}</b><span class="hint">${esc(file.kind)} · ${new Date(file.created_at).toLocaleDateString("en-CA")} · ${Math.ceil(file.size_bytes / 1024).toLocaleString()} KB</span><span class="spacer"></span><button class="btn primary">Download .docx</button></div></div>`);
        card.querySelector("button").onclick = async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const { data: blob, error: downloadError } = await supabase.storage.from("redraft-finals").download(file.storage_path);
            if (downloadError || !blob) throw downloadError || new Error("No file returned.");
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = file.name;
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
          } catch (e) {
            toast("Couldn't download the saved file. Check your connection.");
          } finally { button.disabled = false; }
        };
        finalList.append(card);
      });
    })
    .catch((error) => {
      if (!body.isConnected || S.id !== sessionId) return;
      console.error("Couldn't load saved final files.", error);
      finalList.innerHTML = `<div class="empty">Couldn't load saved final files.</div>`;
      toast("Couldn't load saved files. Check your connection.");
    });
}

/* ---------- downloads ---------- */
function fileBase() {
  const last = (S.resume?.name || "Candidate").split(",")[0].trim().split(/\s+/).pop();
  const role = (S.resume?.experience?.[0]?.title || "Role").split(/[—–|-]/)[0].replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).slice(0, 4).join("");
  return `${last}_${role}`.replace(/[^A-Za-z0-9_]/g, "");
}
async function download(kind, saveFinal = false) {
  try {
    const B = makeBuilders(docxLib);
    let doc, name;
    if (kind === "resume") { doc = B.resume(S.resume); name = fileBase() + "_Resume.docx"; }
    else if (kind === "cover") { doc = B.cover(S.cover, S.resume); name = fileBase() + "_CoverLetter.docx"; }
    else {
      const cov = coverage();
      const flags = S.messages.flatMap((m) => (m.data?.callouts || []).filter((c) => c.severity !== "consider").map((c) => ({ issue: c.text })));
      doc = B.report({ title: S.title || S.resume?.experience?.[0]?.title || "", ...cov, flags: flags.slice(-12) });
      name = fileBase() + "_KeywordReport.docx";
    }
    const blob = await docxLib.Packer.toBlob(doc);
    if (saveFinal) {
      if (!supabase || !userId) { toast("Sign in to save final files to your account."); return; }
      const finalName = await nameSessionDialog(name, {
        heading: "Save this as a final file?",
        note: "This Word document will be saved to your account and listed in this session's Files tab.",
        confirmLabel: "Save as final",
      });
      if (finalName === null) return;
      await saveFinalFile(kind, blob, finalName);
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Downloaded " + name);
  } catch (e) {
    toast(saveFinal ? "Couldn't save the final file. Check your connection." : "Couldn't create the file. Try again.");
  }
}

async function saveFinalFile(kind, blob, requestedName) {
  const baseName = requestedName.trim().replace(/[\\/]/g, "_").replace(/\.docx$/i, "").slice(0, 150).trim();
  if (!baseName) { toast("Enter a name for the final file."); return; }
  const name = baseName + ".docx";
  const id = crypto.randomUUID();
  const storagePath = `${userId}/${S.id}/${id}.docx`;
  const { error: uploadError } = await supabase.storage.from("redraft-finals").upload(storagePath, blob, {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    upsert: false,
  });
  if (uploadError) {
    toast("Couldn't save the final file. Check your connection and storage setup.");
    return;
  }
  const { error: insertError } = await supabase.from("final_files").insert({
    user_id: userId,
    session_id: S.id,
    name,
    kind,
    storage_path: storagePath,
    size_bytes: blob.size,
  });
  if (insertError) {
    const { error: cleanupError } = await supabase.storage.from("redraft-finals").remove([storagePath]);
    if (cleanupError) console.error("Couldn't clean up the uploaded final file after metadata save failed.", cleanupError);
    toast("Couldn't register the final file in your account.");
    return;
  }
  toast("Saved as final: " + name);
  if (tab === "files") renderDocs();
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
function sessionTitle() { return S.title || S.resume?.experience?.[0]?.title || firstDocName() || "Untitled session"; }
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
      if (S.resume) S.resume = normalizeResume(S.resume);
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
      if (supabase) {
        const { data: files, error: listError } = await supabase.from("final_files").select("storage_path").eq("session_id", row.id);
        if (listError) { toast("Couldn't check the session's saved files; nothing was deleted."); return; }
        if (files?.length) {
          const { error: storageError } = await supabase.storage.from("redraft-finals").remove(files.map((file) => file.storage_path));
          if (storageError) { toast("Couldn't remove the session's saved files; nothing was deleted."); return; }
        }
        const { error: deleteError } = await supabase.from("sessions").delete().eq("id", row.id);
        if (deleteError) { toast("Couldn't remove the session from your account."); return; }
      }
      deleteLocalSession(row.id);
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
    if (row?.state) {
      S = { ...freshSession(), ...row.state, id: lastId };
      if (S.resume) S.resume = normalizeResume(S.resume);
    }
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
