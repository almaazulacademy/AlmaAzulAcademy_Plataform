/**
 * Liga `coupons-data.ts` ao Supabase com a service role. Só servidor.
 */

import { createCouponAdminData, type CouponAdminClient } from "@/lib/admin/coupons-data";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export function couponAdminData() {
  const client = getSupabaseAdminClient();
  if (!client) throw new Error("ADMIN_NOT_CONFIGURED");
  // Só o pedaço do supabase-js que o painel usa: as RPCs e o tipo das experiências.
  const narrow: CouponAdminClient = {
    rpc: (name, args) => client.rpc(name, args),
    from: (table) => client.from(table) as unknown as ReturnType<CouponAdminClient["from"]>,
  };
  return createCouponAdminData(narrow);
}
