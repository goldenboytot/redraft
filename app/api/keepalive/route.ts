import { createClient } from "@supabase/supabase-js";

// Called once a day by Vercel Cron so the free Supabase project doesn't pause when idle.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
  const { error } = await supabase.from("sessions").select("id").limit(1);
  return Response.json({ ok: !error, at: new Date().toISOString() });
}
