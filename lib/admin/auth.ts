import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { NextResponse } from "next/server";
import type { Session } from "@supabase/supabase-js";

import { ADMIN_ACCESS_COOKIE, ADMIN_COOKIE_BASE, ADMIN_REFRESH_COOKIE } from "@/lib/admin/auth-cookies";
import type { AdminContext, AdminProfile, AdminRole } from "@/lib/admin/types";
import { getSupabaseAdminClient, getSupabaseServerClient, getSupabaseUserClient } from "@/lib/supabase/server";

type AdminMembershipRow = {
  user_id: string;
  display_name: string;
  role: string;
  is_active: boolean;
};

export type AdminLoginResult =
  | { success: true; session: Session; profile: AdminProfile }
  | { success: false; status: number; message: string };

function isAdminRole(value: string): value is AdminRole {
  return value === "ADMIN" || value === "OPERATOR";
}

async function getMembership(userId: string) {
  const admin = getSupabaseAdminClient();
  if (!admin) return { membership: null, configured: false };

  const result = await admin
    .from("admin_users")
    .select("user_id, display_name, role, is_active")
    .eq("user_id", userId)
    .maybeSingle();

  if (result.error) return { membership: null, configured: false };
  const membership = result.data as AdminMembershipRow | null;
  if (!membership?.is_active || !isAdminRole(membership.role)) {
    return { membership: null, configured: true };
  }
  return { membership, configured: true };
}

export async function authenticateAdminCredentials(email: string, password: string): Promise<AdminLoginResult> {
  const supabase = getSupabaseServerClient();
  if (!supabase || !getSupabaseAdminClient()) {
    return { success: false, status: 503, message: "A autenticação administrativa ainda não está configurada." };
  }

  const login = await supabase.auth.signInWithPassword({ email, password });
  if (login.error || !login.data.user || !login.data.session) {
    return { success: false, status: 401, message: "Email ou senha inválidos." };
  }

  const membershipResult = await getMembership(login.data.user.id);
  if (!membershipResult.membership) {
    await supabase.auth.signOut().catch(() => undefined);
    return {
      success: false,
      status: membershipResult.configured ? 403 : 503,
      message: membershipResult.configured
        ? "Esta conta não possui acesso administrativo ativo."
        : "O controle de administradores ainda não está configurado.",
    };
  }

  return {
    success: true,
    session: login.data.session,
    profile: {
      userId: login.data.user.id,
      email: login.data.user.email ?? email,
      displayName: membershipResult.membership.display_name,
      role: membershipResult.membership.role as AdminRole,
    },
  };
}

export function setAdminSessionCookies(response: NextResponse, session: Session) {
  response.cookies.set(ADMIN_ACCESS_COOKIE, session.access_token, {
    ...ADMIN_COOKIE_BASE,
    maxAge: Math.max(60, session.expires_in),
  });
  response.cookies.set(ADMIN_REFRESH_COOKIE, session.refresh_token, {
    ...ADMIN_COOKIE_BASE,
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearAdminSessionCookies(response: NextResponse) {
  response.cookies.set(ADMIN_ACCESS_COOKIE, "", { ...ADMIN_COOKIE_BASE, maxAge: 0 });
  response.cookies.set(ADMIN_REFRESH_COOKIE, "", { ...ADMIN_COOKIE_BASE, maxAge: 0 });
}

export async function getAdminContextFromAccessToken(accessToken: string): Promise<AdminContext | null> {
  const userClient = getSupabaseUserClient(accessToken);
  if (!userClient) return null;

  const userResult = await userClient.auth.getUser(accessToken);
  if (userResult.error || !userResult.data.user) return null;
  const membershipResult = await getMembership(userResult.data.user.id);
  if (!membershipResult.membership) return null;

  return {
    profile: {
      userId: userResult.data.user.id,
      email: userResult.data.user.email ?? "",
      displayName: membershipResult.membership.display_name,
      role: membershipResult.membership.role as AdminRole,
    },
  };
}

export const getAdminContext = cache(async (): Promise<AdminContext | null> => {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ADMIN_ACCESS_COOKIE)?.value ?? "";
  return accessToken ? getAdminContextFromAccessToken(accessToken) : null;
});

export async function requireAdmin() {
  const context = await getAdminContext();
  if (!context) redirect("/login");
  return context;
}
