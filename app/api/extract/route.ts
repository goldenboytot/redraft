import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { currentUserId } from "@/lib/supabase/server";

export const runtime = "nodejs";
const MAX_BYTES = 10 * 1024 * 1024;

// Turns an uploaded CV or job description into plain text. The file itself is never stored.
export async function POST(request: Request) {
  if (!(await currentUserId())) return Response.json({ error: "Sign in again." }, { status: 401 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file received." }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "That file is over 10 MB." }, { status: 413 });

  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    let text = "";
    if (name.endsWith(".pdf")) {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const out = await extractText(pdf, { mergePages: true });
      text = Array.isArray(out.text) ? out.text.join("\n\n") : out.text;
    } else if (name.endsWith(".docx")) {
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (/\.(txt|md)$/.test(name)) {
      text = buf.toString("utf8");
    } else {
      return Response.json({ error: "Use a .docx, .pdf or .txt file." }, { status: 415 });
    }
    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return Response.json({ error: "No readable text found. If it's a scan, paste the text instead." }, { status: 422 });
    return Response.json({ text });
  } catch {
    return Response.json({ error: "Couldn't read that file. Paste the text instead." }, { status: 422 });
  }
}
