/**
 * Liga `waitlist-data.ts` ao Supabase com a service role. Só servidor.
 */

import { createWaitlistAdminData } from "@/lib/admin/waitlist-data";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export function waitlistAdminData() {
  const client = getSupabaseAdminClient();
  if (!client) throw new Error("ADMIN_NOT_CONFIGURED");
  return createWaitlistAdminData((name, args) => client.rpc(name, args));
}
