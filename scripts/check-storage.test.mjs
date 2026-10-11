import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as docx from "docx";
import { archiveOutputs, storeOutput } from "../lib/redraft/output-storage.js";

function compile(path, dependencies = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, process, require: (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`);
    return dependencies[name];
  } });
  return exports;
}
const access = compile("../lib/admin-access.ts");

test("admin allowlist fails closed and matches exact user IDs", () => {
  assert.equal(access.isAdminId(null, "admin"), false);
  assert.equal(access.isAdminId("member", "admin"), false);
  assert.equal(access.isAdminId("adm", "admin"), false);
  assert.equal(access.isAdminId("admin", ""), false);
  assert.equal(access.isAdminId("admin", " other, admin "), true);
});

test("privileged downloads reject paths outside the recorded user and session", () => {
  const file = { user_id: "owner", session_id: "session", storage_path: "owner/session/file.docx" };
  assert.equal(access.validOutputPath(file), true);
  for (const storage_path of ["other/session/file.docx", "owner/other/file.docx", "owner/session/../file.docx", "owner/session/../../secret", "owner/session/file.html"]) {
    assert.equal(access.validOutputPath({ ...file, storage_path }), false);
  }
});

test("privileged client is never created for unauthenticated or ordinary users", async () => {
  let user = null;
  let created = 0;
  const { adminAccess } = compile("../lib/supabase/admin.ts", {
    "server-only": {},
    "@supabase/supabase-js": { createClient: () => { created++; return {}; } },
    "./server": { supabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } }) },
    "@/lib/admin-access": { isAdminId: (id) => access.isAdminId(id, "admin") },
  });
  assert.equal((await adminAccess()).status, 401);
  user = { id: "member", user_metadata: { admin: true, role: "admin" } };
  assert.equal((await adminAccess()).status, 403);
  assert.equal(created, 0);
});

function mockStorage() {
  const files = new Map();
  const objects = new Map();
  const mock = {
    files, objects, uploads: 0, failInsert: false,
    from: () => ({
      select: () => ({ eq: (_field, path) => ({ maybeSingle: async () => ({ data: files.get(path) || null, error: null }) }) }),
      insert: async (row) => {
        if (mock.failInsert) return { error: { code: "42501" } };
        if (files.has(row.storage_path)) return { error: { code: "23505" } };
        files.set(row.storage_path, row); return { error: null };
      },
    }),
    storage: { from: () => ({
      upload: async (path, blob) => {
        if (objects.has(path)) return { error: { statusCode: "409" } };
        mock.uploads++; objects.set(path, blob); return { error: null };
      },
      remove: async (paths) => { paths.forEach((p) => objects.delete(p)); return { error: null }; },
    }) },
  };
  return mock;
}
const row = () => ({ id: "session-a", updated_at: "2026-10-11T10:00:00.000Z", state: { resume: { name: "Test Candidate", contact: [], summary: ["Example summary"], experience: [], skills: [], degrees: [] } } });

test("unchanged outputs are deduplicated; changed outputs and different owners stay separate", async () => {
  const client = mockStorage();
  const snapshot = row();
  await archiveOutputs(client, "user-a", snapshot, docx);
  await archiveOutputs(client, "user-a", snapshot, docx);
  assert.equal(client.uploads, 1);
  snapshot.state.resume.summary = ["Revised summary"];
  await archiveOutputs(client, "user-a", snapshot, docx);
  await archiveOutputs(client, "user-b", snapshot, docx);
  await archiveOutputs(client, "user-a", { ...snapshot, id: "session-b" }, docx);
  assert.equal(client.uploads, 4);
  assert.equal(client.files.size, 4);
  for (const file of client.files.values()) assert.equal(access.validOutputPath(file), true);
});

test("metadata failures clean up new uploads and can be retried", async () => {
  const client = mockStorage();
  const file = { userId: "user-a", sessionId: "session-a", kind: "resume", blob: new Blob(["test"]), name: "Resume.docx", key: "stable" };
  client.failInsert = true;
  await assert.rejects(storeOutput(client, file));
  assert.equal(client.objects.size, 0);
  assert.equal(client.files.size, 0);
  client.failInsert = false;
  await storeOutput(client, file);
  assert.equal(client.files.size, 1);
});

test("retry registers an upload whose previous metadata save did not complete", async () => {
  const client = mockStorage();
  client.objects.set("user-a/session-a/stable.docx", new Blob(["test"]));
  await storeOutput(client, { userId: "user-a", sessionId: "session-a", kind: "resume", blob: new Blob(["test"]), name: "Resume.docx", key: "stable" });
  assert.equal(client.uploads, 0);
  assert.equal(client.files.size, 1);
});

test("queued saves retain the original session and output when the active session changes", async () => {
  const source = readFileSync(new URL("../lib/redraft/app.js", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const saved = [], archived = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = { from: () => ({ upsert: async (row) => { await gate; saved.push(row); return { error: null }; } }) };
  const exports = {};
  const dependencies = {
    marked: {}, dompurify: {}, docx: {}, "./builders.js": {},
    "./output-storage.js": { archiveOutputs: async (_client, owner, row) => archived.push({ owner, row }) },
  };
  vm.runInNewContext(code + `\nexports.testSetup = (client, state) => { supabase = client; userId = "user-a"; S = state; }; exports.save = doSave; exports.switchSession = setCurrentSession;`, {
    exports, require: (name) => dependencies[name], console, clearTimeout,
    localStorage: { getItem: () => "{}", setItem: () => {} },
  });
  const first = { ...row().state, id: "session-a", title: "First", messages: [{}], docs: [] };
  exports.testSetup(client, first);
  const pending = exports.save();
  exports.switchSession({ ...first, id: "session-b", title: "Second", resume: { name: "Other Candidate" } });
  const next = exports.save();
  release();
  await Promise.all([pending, next]);
  assert.equal(saved[0].id, "session-a");
  assert.equal(archived[0].row.state.resume.name, "Test Candidate");
  assert.equal(archived.at(-1).row.id, "session-b");
  assert.equal(archived.at(-1).row.state.resume.name, "Other Candidate");
});
