import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { NextResponse } from "next/server";
import type { Session } from "@supabase/supabase-js";

import { ADMIN_ACCESS_COOKIE, ADMIN_COOKIE_BASE, ADMIN_REFRESH_COOKIE } from "@/lib/admin/auth-cookies";
import { authErrorDetails, describeAuthFailure } from "@/lib/admin/auth-errors";
import { requestPasswordSession } from "@/lib/admin/password-auth";
import type { AdminContext, AdminProfile, AdminRole } from "@/lib/admin/types";
import { getSupabaseAdminClient, getSupabaseAuthConfigurationSummary, getSupabaseServerClient, getSupabaseUserClient } from "@/lib/supabase/server";

type AdminMembershipRow = {
  user_id: string;
  display_name: string;
  role: string;
  is_active: boolean;
};

type MembershipResult =
  | { membership: AdminMembershipRow; state: "AUTHORIZED" }
  | { membership: null; state: "NOT_AUTHORIZED" | "NOT_CONFIGURED" | "QUERY_ERROR" };

export type AdminLoginResult =
  | { success: true; session: Session; profile: AdminProfile }
  | { success: false; status: number; message: string };

function isAdminRole(value: string): value is AdminRole {
  return value === "ADMIN" || value === "OPERATOR";
}

function authLog(requestId: string, stage: string, details: Record<string, unknown> = {}) {
  // Temporary diagnostic logging. Never include email, password, JWTs or refresh tokens.
  console.info("[admin-auth]", { requestId, stage, ...details });
}

async function getMembership(userId: string, requestId = "session") : Promise<MembershipResult> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    authLog(requestId, "membership_client_missing");
    return { membership: null, state: "NOT_CONFIGURED" };
  }

  const result = await admin
    .from("admin_users")
    .select("user_id, display_name, role, is_active")
    .eq("user_id", userId)
    .maybeSingle();

  if (result.error) {
    authLog(requestId, "membership_query_failed", authErrorDetails(result.error));
    return { membership: null, state: "QUERY_ERROR" };
  }
  const membership = result.data as AdminMembershipRow | null;
  if (!membership?.is_active || !isAdminRole(membership.role)) {
    authLog(requestId, "membership_not_authorized", {
      rowFound: Boolean(membership),
      active: membership?.is_active ?? null,
      validRole: membership ? isAdminRole(membership.role) : false,
    });
    return { membership: null, state: "NOT_AUTHORIZED" };
  }
  authLog(requestId, "membership_authorized", { role: membership.role });
  return { membership, state: "AUTHORIZED" };
}

export async function authenticateAdminCredentials(email: string, password: string, requestId = crypto.randomUUID()): Promise<AdminLoginResult> {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    authLog(requestId, "public_auth_client_missing");
    return { success: false, status: 503, message: "Variável ausente ou inválida: URL e chave pública do Supabase." };
  }
  if (!getSupabaseAdminClient()) {
    authLog(requestId, "admin_auth_client_missing");
    return { success: false, status: 503, message: "Variável ausente: SUPABASE_SERVICE_ROLE_KEY." };
  }

  authLog(requestId, "password_sign_in_started", getSupabaseAuthConfigurationSummary());
  const login = await requestPasswordSession(
    (credentials) => supabase.auth.signInWithPassword(credentials),
    email,
    password,
  );
  if (login.state === "NETWORK_FAILURE") {
    authLog(requestId, "password_sign_in_network_failure", authErrorDetails(login.error));
    return { success: false, ...describeAuthFailure(login.error) };
  }
  if (login.state === "AUTH_REJECTED") {
    authLog(requestId, "password_sign_in_rejected", authErrorDetails(login.error));
    return { success: false, ...describeAuthFailure(login.error) };
  }
  if (login.state === "MISSING_USER") {
    authLog(requestId, "password_sign_in_missing_user");
    return { success: false, status: 502, message: "O Supabase autenticou a solicitação, mas não retornou o usuário." };
  }
  if (login.state === "MISSING_SESSION") {
    authLog(requestId, "password_sign_in_missing_session");
    return { success: false, status: 502, message: "Usuário autenticado, mas o Supabase não criou uma sessão." };
  }

  authLog(requestId, "password_sign_in_succeeded");
  const membershipResult = await getMembership(login.user.id, requestId);
  if (!membershipResult.membership) {
    await supabase.auth.signOut().catch(() => undefined);
    const messages = {
      NOT_AUTHORIZED: "Usuário autenticado, mas sem acesso administrativo ativo.",
      NOT_CONFIGURED: "Variável ausente: SUPABASE_SERVICE_ROLE_KEY.",
      QUERY_ERROR: "Usuário autenticado, mas ocorreu um erro ao consultar admin_users.",
    } as const;
    return {
      success: false,
      status: membershipResult.state === "NOT_AUTHORIZED" ? 403 : 503,
      message: messages[membershipResult.state],
    };
  }

  return {
    success: true,
    session: login.session,
    profile: {
      userId: login.user.id,
      email: login.user.email ?? email,
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
  if (userResult.error || !userResult.data.user) {
    authLog("session", "access_token_rejected", userResult.error ? authErrorDetails(userResult.error) : {});
    return null;
  }
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
