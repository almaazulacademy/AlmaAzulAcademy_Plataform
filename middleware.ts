import { createClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

import { ADMIN_ACCESS_COOKIE, ADMIN_COOKIE_BASE, ADMIN_REFRESH_COOKIE } from "@/lib/admin/auth-cookies";

function unauthorized(request: NextRequest, configured: boolean) {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { message: configured ? "Sessão administrativa inválida ou expirada." : "Supabase Auth ainda não está configurado." },
      { status: configured ? 401 : 503 },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ADMIN_ACCESS_COOKIE, "", { ...ADMIN_COOKIE_BASE, maxAge: 0 });
  response.cookies.set(ADMIN_REFRESH_COOKIE, "", { ...ADMIN_COOKIE_BASE, maxAge: 0 });
  return response;
}

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const configured = Boolean(url && key && !url?.includes("your-project"));
  if (!url || !key || !configured) return unauthorized(request, false);

  const accessToken = request.cookies.get(ADMIN_ACCESS_COOKIE)?.value ?? "";
  const refreshToken = request.cookies.get(ADMIN_REFRESH_COOKIE)?.value ?? "";
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  if (accessToken) {
    const user = await supabase.auth.getUser(accessToken);
    if (!user.error && user.data.user) return NextResponse.next();
  }

  if (refreshToken) {
    const refreshed = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (!refreshed.error && refreshed.data.session) {
      request.cookies.set(ADMIN_ACCESS_COOKIE, refreshed.data.session.access_token);
      request.cookies.set(ADMIN_REFRESH_COOKIE, refreshed.data.session.refresh_token);
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set("cookie", request.cookies.toString());
      const response = NextResponse.next({ request: { headers: requestHeaders } });
      response.cookies.set(ADMIN_ACCESS_COOKIE, refreshed.data.session.access_token, {
        ...ADMIN_COOKIE_BASE,
        maxAge: Math.max(60, refreshed.data.session.expires_in),
      });
      response.cookies.set(ADMIN_REFRESH_COOKIE, refreshed.data.session.refresh_token, {
        ...ADMIN_COOKIE_BASE,
        maxAge: 60 * 60 * 24 * 30,
      });
      return response;
    }
  }

  return clearAuthCookies(unauthorized(request, true));
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
