import Anthropic from "@anthropic-ai/sdk";
import { currentUserId } from "@/lib/supabase/server";
import { HOUSE_RULES } from "@/lib/redraft/rules";

export const runtime = "nodejs";
export const maxDuration = 300;

const MODELS = { standard: "claude-sonnet-5-5", deep: "claude-opus-5-5" } as const;
const MAX_DOC_CHARS = 200_000;
const MAX_TURNS = 40;

type Turn = { role: "user" | "assistant"; content: string };
type Doc = { name: string; text: string };

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

export async function POST(request: Request) {
  if (!(await currentUserId())) return Response.json({ error: "signed_out" }, { status: 401 });

  let body: { docs?: Doc[]; turns?: Turn[]; deep?: boolean };
  try { body = await request.json(); } catch { return Response.json({ error: "bad_request" }, { status: 400 }); }

  // Documents first, cached: they repeat on every message, so caching makes follow-ups much cheaper.
  let budget = MAX_DOC_CHARS;
  let docText = "## Session documents (uploaded by the user; the source of truth for the candidate's facts)\n";
  const docs = Array.isArray(body.docs) ? body.docs : [];
  if (!docs.length) docText += "(none yet)\n";
  docs.forEach((d, i) => {
    const t = String(d.text || "").slice(0, Math.max(0, budget));
    budget -= t.length;
    docText += `\n### Document ${i + 1}: ${String(d.name || "Untitled")}\n<<<\n${t}\n>>>\n`;
  });

  const turns = (Array.isArray(body.turns) ? body.turns : [])
    .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .slice(-MAX_TURNS);
  if (!turns.length || turns[turns.length - 1].role !== "user") {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  // Build strictly alternating messages, starting with the cached documents block.
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: [{ type: "text", text: docText, cache_control: { type: "ephemeral" } }] },
  ];
  for (const t of turns) {
    const last = messages[messages.length - 1];
    if (last.role === t.role) {
      const blocks = Array.isArray(last.content) ? last.content : [{ type: "text" as const, text: String(last.content) }];
      last.content = [...blocks, { type: "text", text: t.content }];
    } else {
      messages.push({ role: t.role, content: t.content });
    }
  }

  const stream = anthropic.messages.stream(
    {
      model: body.deep ? MODELS.deep : MODELS.standard,
      max_tokens: 16000,
      system: [{ type: "text", text: HOUSE_RULES, cache_control: { type: "ephemeral" } }],
      messages,
    },
    { signal: request.signal },
  );

  const enc = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            controller.enqueue(enc.encode(ev.delta.text));
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "max_tokens") controller.enqueue(enc.encode("\u0000TRUNCATED"));
      } catch (e: unknown) {
        const status = (e as { status?: number })?.status;
        const code = status === 429 ? "rate_limited" : status === 529 ? "overloaded" : request.signal.aborted ? "cancelled" : "upstream_error";
        try { controller.enqueue(enc.encode("\u0000ERROR:" + code)); } catch {}
      } finally {
        try { controller.close(); } catch {}
      }
    },
    cancel() { stream.abort(); },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
