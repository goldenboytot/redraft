import { makeBuilders } from "./builders.js";

export const OUTPUT_BUCKET = "redraft-finals";
const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Capture the session before any asynchronous work; never use the active UI session here.
export async function storeOutput(client, { userId, sessionId, kind, blob, name, key = crypto.randomUUID() }) {
  const path = `${userId}/${sessionId}/${key}.docx`;
  const { data: existing, error: lookupError } = await client.from("final_files")
    .select("id").eq("storage_path", path).maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return;
  const storage = client.storage.from(OUTPUT_BUCKET);
  const { error: uploadError } = await storage.upload(path, blob, { contentType: MIME, upsert: false });
  // A previous upload may have succeeded before the metadata request failed.
  if (uploadError && String(uploadError.statusCode) !== "409") throw uploadError;
  const { error: insertError } = await client.from("final_files").insert({
    user_id: userId, session_id: sessionId, name, kind, storage_path: path, size_bytes: blob.size,
  });
  // A concurrent tab may already have registered this exact content.
  if (insertError && insertError.code !== "23505") {
    // Only remove an object created by this call, not a concurrent tab's upload.
    if (!uploadError) await storage.remove([path]).catch(() => {});
    throw insertError;
  }
}

export async function archiveOutputs(client, userId, row, docx) {
  const builders = makeBuilders(docx);
  for (const kind of ["resume", "cover"]) {
    const content = row.state[kind];
    if (!content) continue;
    const source = kind === "cover" ? [content, row.state.resume] : content;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source)));
    const hash = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
    const key = `auto-${kind}-${hash}`;
    // Avoid building a Word file on every chat save when the output is unchanged.
    const { data, error } = await client.from("final_files").select("id")
      .eq("storage_path", `${userId}/${row.id}/${key}.docx`).maybeSingle();
    if (error) throw error;
    if (data) continue;
    const doc = kind === "resume" ? builders.resume(content) : builders.cover(content, row.state.resume);
    await storeOutput(client, {
      userId, sessionId: row.id, kind, key, blob: await docx.Packer.toBlob(doc),
      name: `${kind === "resume" ? "Resume" : "CoverLetter"}_Autosaved_${row.updated_at.replace(/[:.]/g, "-")}.docx`,
    });
  }
}
