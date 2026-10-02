/* Word document builders for Tobi's Calibri house CV format. */
export function makeBuilders(D) {
  const FONT = "Calibri";
  const NAVY = "1F4E79";
  const GREY = "555555";
  const t = (text, options = {}) => new D.TextRun({
    text: String(text ?? ""),
    font: FONT,
    size: options.size ?? 20,
    color: options.color ?? "000000",
    bold: options.bold,
    italics: options.italics,
  });
  const paragraph = (style, children, options = {}) => new D.Paragraph({ style, children, ...options });
  const clean = (values) => (Array.isArray(values) ? values : []).map((value) => String(value ?? "").trim()).filter(Boolean);
  const numbering = {
    config: [{
      reference: "cvBullets",
      levels: [{
        level: 0,
        format: D.LevelFormat.BULLET,
        text: "•",
        alignment: D.AlignmentType.LEFT,
        style: {
          paragraph: { indent: { left: 440, hanging: 280 } },
          run: { font: FONT, color: "000000" },
        },
      }],
    }],
  };
  const lineSpacing = { line: 240, lineRule: D.LineRuleType.EXACT };
  const styles = {
    default: {
      document: {
        run: { font: FONT, size: 20, color: "000000" },
        paragraph: { spacing: lineSpacing },
      },
    },
    paragraphStyles: [
      { id: "Normal", name: "Normal", run: { font: FONT, size: 20, color: "000000" }, paragraph: { spacing: lineSpacing } },
      { id: "Name", name: "Name", basedOn: "Normal", run: { font: FONT, size: 36, bold: true, color: NAVY }, paragraph: { alignment: D.AlignmentType.CENTER, spacing: { after: 60, ...lineSpacing } } },
      { id: "Contact", name: "Contact", basedOn: "Normal", run: { font: FONT, size: 19, color: GREY }, paragraph: { alignment: D.AlignmentType.CENTER, spacing: { after: 40, ...lineSpacing } } },
      { id: "HeaderRule", name: "Header Rule", basedOn: "Normal", run: { font: FONT, size: 8, color: "000000" }, paragraph: { spacing: { after: 120, ...lineSpacing }, border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, space: 4, color: NAVY } } } },
      { id: "SectionHeading", name: "Section Heading", basedOn: "Heading1", next: "Summary", run: { font: FONT, size: 22, bold: true, color: NAVY }, paragraph: { outlineLevel: 0, spacing: { before: 160, after: 60, ...lineSpacing }, border: { bottom: { style: D.BorderStyle.SINGLE, size: 8, space: 2, color: NAVY } }, keepNext: true } },
      { id: "Summary", name: "Summary", basedOn: "Normal", run: { font: FONT, size: 20, color: "000000" }, paragraph: { spacing: { before: 80, after: 80, ...lineSpacing } } },
      { id: "AchievementHeading", name: "Achievement Heading", basedOn: "Normal", run: { font: FONT, size: 20, bold: true, italics: true, color: "000000" }, paragraph: { spacing: { before: 40, after: 40, ...lineSpacing }, keepNext: true } },
      { id: "JobTitle", name: "Job Title", basedOn: "Normal", next: "Employer", run: { font: FONT, size: 22, bold: true, color: NAVY }, paragraph: { tabStops: [{ type: D.TabStopType.RIGHT, position: 9360 }], spacing: { before: 120, after: 20, ...lineSpacing }, keepNext: true } },
      { id: "Employer", name: "Employer", basedOn: "Normal", next: "RoleSummary", run: { font: FONT, size: 20, bold: true, color: GREY }, paragraph: { spacing: { after: 60, ...lineSpacing }, keepNext: true } },
      { id: "RoleSummary", name: "Role Summary", basedOn: "Normal", next: "Bullet", run: { font: FONT, size: 20, color: "000000" }, paragraph: { spacing: { before: 40, after: 60, ...lineSpacing } } },
      { id: "Bullet", name: "Bullet", basedOn: "Normal", next: "Bullet", paragraph: { indent: { left: 440, hanging: 280 }, spacing: { before: 40, after: 40, ...lineSpacing } } },
      { id: "SkillBullet", name: "Skill Bullet", basedOn: "Bullet", paragraph: { indent: { left: 440, hanging: 280 }, spacing: { before: 40, after: 40, ...lineSpacing } } },
      { id: "Degree", name: "Degree", basedOn: "Normal", run: { font: FONT, size: 20, bold: true, color: "000000" }, paragraph: { tabStops: [{ type: D.TabStopType.RIGHT, position: 9360 }], spacing: { before: 80, after: 30, ...lineSpacing }, keepNext: true } },
      { id: "Institution", name: "Institution", basedOn: "Normal", run: { font: FONT, size: 20, color: GREY }, paragraph: { spacing: { after: 40, ...lineSpacing } } },
      { id: "SubLabel", name: "Sub Label", basedOn: "Normal", run: { font: FONT, size: 20, bold: true, color: "000000" }, paragraph: { spacing: { before: 80, after: 20, ...lineSpacing }, keepNext: true } },
      { id: "CoverDate", name: "Cover Date", basedOn: "Normal", run: { font: FONT, size: 22, color: "000000" }, paragraph: { spacing: { before: 240, after: 160, ...lineSpacing } } },
      { id: "CoverGreeting", name: "Cover Greeting", basedOn: "Normal", run: { font: FONT, size: 22, color: "000000" }, paragraph: { spacing: { after: 160, ...lineSpacing }, keepNext: true } },
      { id: "CoverParagraph", name: "Cover Paragraph", basedOn: "Normal", run: { font: FONT, size: 22, color: "000000" }, paragraph: { spacing: { after: 160, ...lineSpacing } } },
      { id: "CoverSignoff", name: "Cover Signoff", basedOn: "Normal", run: { font: FONT, size: 22, color: "000000" }, paragraph: { spacing: { before: 160, after: 0, ...lineSpacing } } },
      { id: "CoverName", name: "Cover Name", basedOn: "CoverParagraph", run: { font: FONT, size: 22, color: "000000" }, paragraph: { spacing: { after: 0, ...lineSpacing } } },
    ],
  };
  const page = {
    page: {
      size: { width: 12240, height: 15840 },
      margin: { top: 1080, bottom: 1080, left: 1260, right: 1041 },
    },
  };
  const docOf = (children, title) => new D.Document({
    creator: "Redraft",
    title: title || "Resume",
    styles,
    numbering,
    sections: [{ properties: page, children }],
  });
  const bullet = (text, style = "Bullet") => paragraph(style, [t(text)], { numbering: { reference: "cvBullets", level: 0 } });
  const headerBlock = (name, contacts) => [
    paragraph("Name", [t(String(name || "").toUpperCase(), { size: 36, bold: true, color: NAVY })]),
    paragraph("Contact", [t(clean(contacts).join("  |  "), { size: 19, color: GREY })]),
    paragraph("HeaderRule", [t("", { size: 8 })]),
  ];

  function resume(r) {
    const c = headerBlock(r.name, r.contact);
    const section = (title) => c.push(paragraph("SectionHeading", [t(title.toUpperCase(), { size: 22, bold: true, color: NAVY })]));
    const summary = clean(r.summary);
    if (summary.length) {
      section("Professional Summary");
      summary.forEach((text) => c.push(paragraph("Summary", [t(text)])));
    }
    const achievements = Array.isArray(r.achievements) ? r.achievements : [];
    if (achievements.length) {
      section("Key Achievements");
      achievements.forEach((achievement) => {
        if (achievement.header) c.push(paragraph("AchievementHeading", [t(achievement.header, { bold: true, italics: true })]));
        clean(achievement.bullets).slice(0, 2).forEach((text) => c.push(bullet(text)));
      });
    }
    const experience = Array.isArray(r.experience) ? r.experience : [];
    if (experience.length) {
      section("Professional Experience");
      experience.forEach((role) => {
        const title = [];
        if (role.title) title.push(t(role.title, { bold: true, color: NAVY }));
        title.push(new D.TextRun({ text: "\t" }));
        if (role.dates) title.push(t(role.dates, { size: 19, italics: true, bold: false, color: GREY }));
        c.push(paragraph("JobTitle", title));
        const employer = [role.employer, role.location].filter(Boolean).join(" | ");
        if (employer) c.push(paragraph("Employer", [t(employer, { bold: true, color: GREY })]));
        if (role.summary) c.push(paragraph("RoleSummary", [t(role.summary)]));
        clean(role.bullets).forEach((text) => c.push(bullet(text)));
      });
    }
    const values = (Array.isArray(r.values) ? r.values : []).filter((value) => value && (value.value || value.line));
    if (values.length) {
      section("Values Alignment");
      values.forEach((value) => c.push(paragraph("SkillBullet", [
        t(`${value.value || ""}: `, { bold: Boolean(value.value) }),
        t(value.line || ""),
      ], { numbering: { reference: "cvBullets", level: 0 } })));
    }
    const skills = (Array.isArray(r.skills) ? r.skills : []).filter((skill) => skill && (skill.label || skill.items));
    if (skills.length) {
      section("Skills, Tools & Competencies");
      skills.forEach((skill) => c.push(paragraph("SkillBullet", [
        t(`${skill.label || ""}: `, { bold: Boolean(skill.label) }),
        t(skill.items || ""),
      ], { numbering: { reference: "cvBullets", level: 0 } })));
    }
    const degrees = Array.isArray(r.degrees) ? r.degrees : [];
    const certifications = clean(r.certifications);
    if (degrees.length || certifications.length) {
      section("Education & Certifications");
      degrees.forEach((degree) => {
        const runs = [];
        if (degree.degree) runs.push(t(degree.degree, { bold: true }));
        runs.push(new D.TextRun({ text: "\t" }));
        if (degree.year) runs.push(t(degree.year, { size: 19, italics: true, color: GREY }));
        c.push(paragraph("Degree", runs));
        if (degree.institution) c.push(paragraph("Institution", [t(degree.institution, { color: GREY })]));
      });
      if (certifications.length) {
        c.push(paragraph("SubLabel", [t("Professional Certifications:", { bold: true })]));
        certifications.forEach((certification) => c.push(bullet(certification)));
      }
    }
    const additional = clean(r.additional);
    if (additional.length) {
      section("Additional Information");
      additional.forEach((text) => c.push(bullet(text)));
    }
    return docOf(c, `${r.name || ""} Resume`);
  }

  function cover(cl, r) {
    const c = headerBlock(r?.name, r?.contact);
    c.push(paragraph("CoverDate", [t(new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" }), { size: 22 })]));
    c.push(paragraph("CoverGreeting", [t(cl.greeting || "Dear Hiring Manager,", { size: 22 })]));
    clean(cl.paragraphs).forEach((text) => c.push(paragraph("CoverParagraph", [t(text, { size: 22 })])));
    c.push(paragraph("CoverSignoff", [t(cl.signoff || "Sincerely,", { size: 22 })]));
    c.push(paragraph("CoverName", [t(r?.name || "", { size: 22 })]));
    return docOf(c, `${r?.name || ""} Cover Letter`);
  }

  function report(rep) {
    const c = [paragraph("SectionHeading", [t("KEYWORD MATCH REPORT", { size: 22, bold: true, color: NAVY })])];
    c.push(paragraph("Summary", [t(rep.title || "")]));
    c.push(paragraph("Summary", [t(`Resume covers ${rep.inResume} of ${rep.total} job description phrases (${rep.pct}%).`, { bold: true })]));
    const block = (name, items, format) => {
      if (!items.length) return;
      c.push(paragraph("SectionHeading", [t(`${name} (${items.length})`.toUpperCase(), { size: 22, bold: true, color: NAVY })]));
      items.forEach((item) => c.push(bullet(format(item))));
    };
    block("In resume, exact wording", rep.groups.resume, (item) => item.phrase);
    block("Only in cover letter", rep.groups.cover, (item) => item.phrase);
    block("Missing, could be claimed", rep.groups.claimable, (item) => item.phrase + (item.evidence ? ` (evidence: ${item.evidence})` : ""));
    block("Honest gaps", rep.groups.gap, (item) => item.phrase + (item.evidence ? ` (${item.evidence})` : ""));
    if (rep.flags?.length) block("Verify before sending", rep.flags, (flag) => (flag.where ? `${flag.where}: ` : "") + flag.issue);
    return docOf(c, "Keyword Match Report");
  }

  return { resume, cover, report };
}
