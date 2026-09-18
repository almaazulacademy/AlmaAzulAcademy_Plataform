import { buildPasswordResetEmail } from "@/lib/auth/password-reset-email";
import type { ResetCompleteDeps, ResetMembership, ResetRequestDeps } from "@/lib/auth/password-reset";
import { resolveCheckinOrigin } from "@/lib/checkin/origin";
import { getEmailProvider } from "@/lib/email";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase/server";

// Ligação da recuperação de senha com Supabase (service role, só no servidor)
// e com o provedor de e-mail do site. Nada aqui chega ao navegador.

const REQUESTED = "PASSWORD_RESET_REQUESTED";
const COMPLETED = "PASSWORD_RESET_COMPLETED";

function log(stage: string, details: Record<string, unknown> = {}) {
  // Nunca registrar e-mail, senha, token ou link.
  console.info("[password-reset]", { stage, ...details });
}

function adminClient() {
  const client = getSupabaseAdminClient();
  if (!client) throw new Error("ADMIN_NOT_CONFIGURED");
  return client;
}

async function membership(userId: string): Promise<ResetMembership | null> {
  const result = await adminClient().from("admin_users").select("role, is_active, display_name").eq("user_id", userId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { role: string; is_active: boolean; display_name: string } | null;
  return row ? { role: row.role, isActive: row.is_active, displayName: row.display_name } : null;
}

async function record(action: string, userId: string) {
  const result = await adminClient().from("admin_audit_log").insert({
    actor_user_id: userId, action, entity_type: "ADMIN_USER", entity_id: userId, metadata: {},
  });
  if (result.error) throw new Error(result.error.message);
}

/** null quando o envio de e-mail não está configurado neste ambiente. */
export function passwordResetRequestDeps(): ResetRequestDeps | null {
  const provider = getEmailProvider();
  if (!provider) return null;
  const client = adminClient();
  return {
    async generateLink(email) {
      const result = await client.auth.admin.generateLink({ type: "recovery", email });
      const tokenHash = result.data?.properties?.hashed_token;
      if (result.error || !result.data?.user || !tokenHash) return null;
      return { userId: result.data.user.id, tokenHash };
    },
    membership,
    async recentRequests(userId) {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const result = await client.from("admin_audit_log").select("created_at")
        .eq("action", REQUESTED).eq("entity_id", userId).gte("created_at", since)
        .order("created_at", { ascending: false });
      if (result.error) throw new Error(result.error.message);
      const rows = (result.data ?? []) as Array<{ created_at: string }>;
      const last = rows[0] ? (Date.now() - new Date(rows[0].created_at).getTime()) / 1000 : null;
      return { secondsSinceLast: last, lastHour: rows.length };
    },
    async send(message) {
      await provider.send(buildPasswordResetEmail(message));
    },
    record: (userId) => record(REQUESTED, userId),
    origin: resolveCheckinOrigin(),
    log,
  };
}

export function passwordResetCompleteDeps(): ResetCompleteDeps {
  const admin = adminClient();
  const publicClient = getSupabaseServerClient();
  if (!publicClient) throw new Error("ADMIN_NOT_CONFIGURED");
  return {
    async verify(tokenHash) {
      const result = await publicClient.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
      const session = result.data?.session;
      const user = result.data?.user;
      if (result.error || !session || !user?.email) return null;
      return { userId: user.id, email: user.email, accessToken: session.access_token };
    },
    membership,
    async updatePassword(userId, password) {
      const result = await admin.auth.admin.updateUserById(userId, { password });
      if (!result.error) return "OK";
      return (result.error as { code?: string }).code === "weak_password" ? "WEAK_PASSWORD" : "FAILED";
    },
    async signOutEverywhere(accessToken) {
      const result = await admin.auth.admin.signOut(accessToken, "global");
      if (result.error) throw new Error(result.error.message);
    },
    record: (userId) => record(COMPLETED, userId),
    log,
  };
}
