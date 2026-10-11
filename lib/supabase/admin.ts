import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseServer } from "./server";
import { isAdminId } from "@/lib/admin-access";

// Call before every privileged query, including file downloads. Never use user_metadata.
export async function adminAccess() {
  const session = await supabaseServer();
  const { data, error } = await session.auth.getUser();
  if (error || !data.user) return { status: 401 as const, client: null };
  if (!isAdminId(data.user.id)) return { status: 403 as const, client: null };
  const key = process.env.SUPABASE_SECRET_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!key || !url) return { status: 503 as const, client: null };
  return { status: 200 as const, client: createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) };
}
