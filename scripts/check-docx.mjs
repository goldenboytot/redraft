import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import * as docx from "docx";

const builderSource = await readFile(new URL("../lib/redraft/builders.js", import.meta.url), "utf8");
const builderModuleUrl = `data:text/javascript;base64,${Buffer.from(builderSource).toString("base64")}`;
const { makeBuilders } = await import(builderModuleUrl);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const exportPackages = /^(jspdf|pdfmake|@react-pdf\/.*|puppeteer.*|html2pdf.*|pdf-lib|pdfkit|html-pdf|playwright|phantomjs.*|wkhtmltopdf)$/i;
for (const name of Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
  assert.ok(!exportPackages.test(name), `PDF-generation dependency remains: ${name}`);
}
for (const name of Object.keys(packageLock.packages || {})) {
  const packageName = name.replace(/^node_modules\//, "");
  assert.ok(!exportPackages.test(packageName), `PDF-generation dependency remains in lockfile: ${packageName}`);
}
const appSource = await readFile(new URL("../lib/redraft/app.js", import.meta.url), "utf8");
assert.doesNotMatch(appSource, /download\(["']pdf|\.pdf["']\s*\)|PDF export/i, "app.js must not contain a PDF export path");

const outputPath = new URL("../tmp/sample_resume.docx", import.meta.url);
const builders = makeBuilders(docx);
const resume = {
  name: "TOBI TOWOJU, PMP, CIPM",
  contact: ["Calgary, Alberta", "403-555-0100", "tobi@example.com", "linkedin.com/in/tobi"],
  summary: [
    "Senior program leader with 12 years of experience delivering public-sector modernization and information governance initiatives. Leads enterprise programs that connect business strategy, service design, policy, and technology to improve outcomes for residents. Brings deep experience in information and records management, privacy and access legislation, executive governance, and large-scale transformation across complex provincial organizations. Translates exact business and regulatory requirements into practical roadmaps, accountable delivery plans, and measurable operational improvements. Builds trusted relationships with executives, partners, and multidisciplinary teams while maintaining transparent decision-making and sound stewardship of public resources.",
  ],
  skills: [
    { label: "Information & Records Management", items: "records governance, retention, information lifecycle" },
    { label: "Privacy & Access Legislation", items: "privacy impact assessments, access to information" },
    { label: "Program Leadership & Stakeholder Engagement", items: "portfolio delivery, executive governance" },
    { label: "Frameworks & Methodologies", items: "Agile, project governance, change management" },
    { label: "Tools & Systems", items: "Microsoft 365, SharePoint, Power BI" },
  ],
  achievements: [
    { header: "Records Governance Transformation — $605M ELCC Modernization", bullets: ["Directed governance across 12 departments, improving records controls and service access."] },
    { header: "Enterprise Information Lifecycle — Provincial Program", bullets: ["Established standards that reduced duplicate records by 30%."] },
    { header: "Privacy Operations Renewal — Multi-Agency Initiative", bullets: ["Implemented consistent privacy reviews for 8 delivery teams."] },
  ],
  degrees: [
    { degree: "Master of Science, Information Technology Management (MSIT)", institution: "Atlantic International University, USA", year: "2023" },
  ],
  certifications: ["Certified Information Privacy Manager (CIPM) — International Association of Privacy Professionals (IAPP), 2025"],
  experience: [
    {
      title: "Senior Program Manager",
      dates: "May 2022 – Present",
      employer: "Public Service",
      location: "Halifax, NS",
      summary: "Led a multi-year modernization initiative across provincial departments. Directed delivery governance and executive reporting for a complex portfolio.",
      bullets: ["Directed cross-functional teams across 12 departments."],
    },
  ],
  values: [],
  additional: [],
};

await mkdir(new URL("../tmp/", import.meta.url), { recursive: true });
const buffer = await docx.Packer.toBuffer(builders.resume(resume));
await writeFile(outputPath, buffer);

const archive = await JSZip.loadAsync(buffer);
const documentXml = await archive.file("word/document.xml").async("string");
const stylesXml = await archive.file("word/styles.xml").async("string");

for (const tag of ["tbl", "txbxContent", "headerReference", "footerReference"]) {
  assert.doesNotMatch(documentXml, new RegExp(`<w:${tag}(?:\\s|>)`), `document.xml must not contain w:${tag}`);
}
const section = documentXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)?.[0];
assert.ok(section, "document.xml must define page section properties");
assert.match(section, /<w:pgMar\b[^>]*w:top="1080"[^>]*w:right="1041"[^>]*w:bottom="1080"[^>]*w:left="1260"/, "US Letter page margins must match the house CV spec");
for (const style of ["Name", "Contact", "HeaderRule", "SectionHeading", "Summary", "AchievementHeading", "JobTitle", "Employer", "RoleSummary", "Bullet", "SkillBullet", "Degree", "Institution", "SubLabel"]) {
  assert.match(stylesXml, new RegExp(`<w:style\\b[^>]*w:styleId="${style}"`), `styles.xml must define ${style}`);
}
assert.match(stylesXml, /<w:style\b[^>]*w:styleId="Heading1"/, "Section Heading must inherit from Heading 1");
assert.match(stylesXml, /<w:color\b[^>]*w:val="1F4E79"/, "styles.xml must use the navy accent");

const usedFonts = [...`${documentXml}${stylesXml}`.matchAll(/<w:rFonts\b[^>]*w:ascii="([^"]+)"/g)].map((match) => match[1]);
assert.ok(usedFonts.length > 0, "DOCX must declare run fonts");
assert.ok(usedFonts.every((font) => font === "Calibri"), `Expected Calibri for all run fonts, found: ${[...new Set(usedFonts)].join(", ")}`);

console.log(`DOCX checks passed: ${outputPath.pathname}`);
