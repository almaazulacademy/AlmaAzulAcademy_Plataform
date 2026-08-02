import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { ADMIN_ACCESS_COOKIE, ADMIN_REFRESH_COOKIE } from "@/lib/admin/auth-cookies";
import { clearAdminSessionCookies } from "@/lib/admin/auth";
import { isSameOriginRequest } from "@/lib/admin/http";
import { getSupabaseUserClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }

  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ADMIN_ACCESS_COOKIE)?.value ?? "";
  const refreshToken = cookieStore.get(ADMIN_REFRESH_COOKIE)?.value ?? "";
  const userClient = getSupabaseUserClient(accessToken);

  if (userClient && accessToken && refreshToken) {
    const session = await userClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (!session.error) await userClient.auth.signOut({ scope: "local" });
  }

  const response = NextResponse.json({ success: true });
  clearAdminSessionCookies(response);
  return response;
}
