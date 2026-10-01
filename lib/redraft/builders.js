/* ---------- Word document builders (ATS-clean: Calibri, single column, no tables/headers/footers) ---------- */
export function makeBuilders(D) {
  const FONT = "Calibri";
  const t = (text, o = {}) => new D.TextRun({ text: String(text ?? ""), font: FONT, size: o.size ?? 22, bold: o.bold, italics: o.italics });
  const p = (runs, o = {}) => new D.Paragraph({
    children: Array.isArray(runs) ? runs : [t(runs, o)],
    spacing: { after: o.after ?? 80, before: o.before ?? 0, line: 264 },
    alignment: o.align,
  });
  const header = (text) => new D.Paragraph({
    children: [t(String(text).toUpperCase(), { bold: true, size: 23 })],
    spacing: { before: 220, after: 90 },
    border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: "404040", space: 2 } },
  });
  const bullet = (text, boldLead) => {
    const runs = [];
    if (boldLead) runs.push(t(boldLead, { bold: true }));
    runs.push(t(text));
    return new D.Paragraph({ children: runs, numbering: { reference: "dots", level: 0 }, spacing: { after: 60, line: 264 } });
  };
  const numbering = {
    config: [{
      reference: "dots",
      levels: [{ level: 0, format: D.LevelFormat.BULLET, text: "•", alignment: D.AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 360, hanging: 240 } }, run: { font: FONT } } }],
    }],
  };
  const page = { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } };
  const docOf = (children, title) => new D.Document({
    creator: "Resume Rewrite", title: title || "Resume",
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    numbering,
    sections: [{ properties: page, children }],
  });
  const clean = (a) => (Array.isArray(a) ? a : []).map((x) => (typeof x === "string" ? x.trim() : x)).filter(Boolean);

  function resume(r) {
    const c = [];
    c.push(p([t(r.name || "", { bold: true, size: 32 })], { after: 40 }));
    if (r.headline) c.push(p([t(r.headline, { bold: true, size: 24 })], { after: 40 }));
    const contact = clean(r.contact).join("  |  ");
    if (contact) c.push(p([t(contact, { size: 20 })], { after: 120 }));

    const summary = clean(r.summary);
    if (summary.length) { c.push(header("Professional Summary")); summary.forEach((s) => c.push(p(s, { after: 100 }))); }

    const ach = (r.achievements || []).filter((a) => a && (a.header || clean(a.bullets).length));
    if (ach.length) {
      c.push(header("Key Achievements"));
      ach.forEach((a) => {
        if (a.header) c.push(p([t(a.header, { bold: true })], { after: 40, before: 60 }));
        clean(a.bullets).forEach((b) => c.push(bullet(b)));
      });
    }

    const exp = (r.experience || []).filter(Boolean);
    if (exp.length) {
      c.push(header("Professional Experience"));
      exp.forEach((e, i) => {
        c.push(p([t(e.title || "", { bold: true })], { after: 20, before: i ? 160 : 40 }));
        const meta = [e.employer, e.location, e.dates].map((x) => (x || "").trim()).filter(Boolean).join("  |  ");
        if (meta) c.push(p([t(meta, { italics: true })], { after: 60 }));
        (e.groups || []).forEach((g) => {
          if (g.header) c.push(p([t(g.header, { bold: true, size: 21 })], { after: 30, before: 60 }));
          clean(g.bullets).forEach((b) => c.push(bullet(b)));
        });
      });
    }

    const vals = (r.values || []).filter((v) => v && v.value);
    if (vals.length) {
      c.push(header("Values Alignment"));
      vals.forEach((v) => c.push(bullet(v.line || "", v.value + ": ")));
    }

    const skills = (r.skills || []).filter((s) => s && s.items);
    if (skills.length) {
      c.push(header("Skills"));
      skills.forEach((s) => c.push(p([t(String(s.header || "").toUpperCase() + ": ", { bold: true }), t(s.items)], { after: 70 })));
    }

    const creds = clean(r.credentials);
    if (creds.length) { c.push(header("Certifications")); creds.forEach((x) => c.push(bullet(x))); }
    const edu = clean(r.education);
    if (edu.length) { c.push(header("Education")); edu.forEach((x) => c.push(bullet(x))); }
    const add = clean(r.additional);
    if (add.length) { c.push(header("Additional Information")); add.forEach((x) => c.push(bullet(x))); }
    return docOf(c, (r.name || "") + " Resume");
  }

  function cover(cl, r) {
    const c = [];
    c.push(p([t(r?.name || "", { bold: true, size: 28 })], { after: 30 }));
    const contact = clean(r?.contact).join("  |  ");
    if (contact) c.push(p([t(contact, { size: 20 })], { after: 240 }));
    c.push(p(new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" }), { after: 240 }));
    c.push(p(cl.greeting || "Dear Hiring Manager,", { after: 160 }));
    clean(cl.paragraphs).forEach((x) => c.push(p(x, { after: 160 })));
    c.push(p(cl.signoff || "Sincerely,", { after: 40, before: 80 }));
    c.push(p(r?.name || ""));
    return docOf(c, (r?.name || "") + " Cover Letter");
  }

  function report(rep) {
    const c = [];
    c.push(p([t("Keyword Match Report", { bold: true, size: 30 })], { after: 40 }));
    c.push(p([t(rep.title || "", { size: 22 })], { after: 160 }));
    c.push(p([t(`Resume covers ${rep.inResume} of ${rep.total} job description phrases (${rep.pct}%).`, { bold: true })], { after: 120 }));
    const block = (name, items, fmt) => {
      if (!items.length) return;
      c.push(header(name + " (" + items.length + ")"));
      items.forEach((k) => c.push(bullet(fmt(k))));
    };
    block("In resume, exact wording", rep.groups.resume, (k) => k.phrase);
    block("Only in cover letter", rep.groups.cover, (k) => k.phrase);
    block("Missing, could be claimed", rep.groups.claimable, (k) => k.phrase + (k.evidence ? " (evidence: " + k.evidence + ")" : ""));
    block("Honest gaps", rep.groups.gap, (k) => k.phrase + (k.evidence ? " (" + k.evidence + ")" : ""));
    if (rep.flags?.length) block("Verify before sending", rep.flags, (f) => (f.where ? f.where + ": " : "") + f.issue);
    return docOf(c, "Keyword Match Report");
  }

  return { resume, cover, report };
}
