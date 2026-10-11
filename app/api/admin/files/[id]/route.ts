import { NextResponse } from "next/server";
import { adminAccess } from "@/lib/supabase/admin";
import { validOutputPath } from "@/lib/admin-access";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { client, status } = await adminAccess();
  if (!client) return NextResponse.json({ error: status === 503 ? "Admin storage is not configured." : "Access denied." }, { status, headers });
  const { id } = await params;
  if (!/^[a-f\d-]{36}$/i.test(id)) return NextResponse.json({ error: "File not found." }, { status: 404, headers });
  const { data: file, error } = await client.from("final_files").select("user_id,session_id,name,storage_path").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: "Could not load file." }, { status: 502, headers });
  if (!file || !validOutputPath(file)) return NextResponse.json({ error: "File not found." }, { status: 404, headers });
  // Also verify the session owner; metadata is written by the user's client.
  const { data: session } = await client.from("sessions").select("user_id").eq("id", file.session_id).eq("user_id", file.user_id).maybeSingle();
  if (!session) return NextResponse.json({ error: "File not found." }, { status: 404, headers });
  const { data, error: downloadError } = await client.storage.from("redraft-finals").download(file.storage_path);
  if (downloadError || !data) return NextResponse.json({ error: "Could not download file." }, { status: 502, headers });
  const name = file.name.replace(/[\r\n]/g, "");
  return new Response(data, { headers: { ...headers,
    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `attachment; filename="output.docx"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, "%27")}`,
    "X-Content-Type-Options": "nosniff",
  } });
}
