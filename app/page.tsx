import RedraftApp from "@/components/RedraftApp";
import { currentUserId } from "@/lib/supabase/server";
import { isAdminId } from "@/lib/admin-access";

export default async function Home() {
  return <RedraftApp isAdmin={isAdminId(await currentUserId())} />;
}
