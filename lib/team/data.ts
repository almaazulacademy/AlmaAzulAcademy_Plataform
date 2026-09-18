import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { generateInviteToken, hashInviteToken, INVITE_VALID_DAYS, inviteUrl, parseInviteState, type InviteState } from "@/lib/team/invite";
import type { SignupDeps } from "@/lib/team/signup";

// Toda chamada passa pelo service role, só no servidor, e toda RPC confere o
// papel de quem age (`p_actor_id`) de novo no banco.

function adminClient() {
  const client = getSupabaseAdminClient();
  if (!client) throw new Error("ADMIN_NOT_CONFIGURED");
  return client;
}

export type TeamInstructor = {
  userId: string;
  displayName: string;
  email: string;
  isActive: boolean;
  createdAt: string;
  lastSignInAt: string | null;
};

export type TeamInvite = {
  inviteId: string;
  state: InviteState;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByName: string | null;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");
const optionalText = (value: unknown) => (typeof value === "string" && value ? value : null);

export function parseTeam(value: unknown): { instructors: TeamInstructor[]; invites: TeamInvite[] } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rows = (list: unknown) => (Array.isArray(list) ? list.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : []);
  return {
    instructors: rows(record.instructors).map((row) => ({
      userId: text(row.userId),
      displayName: text(row.displayName),
      email: text(row.email),
      isActive: row.isActive === true,
      createdAt: text(row.createdAt),
      lastSignInAt: optionalText(row.lastSignInAt),
    })),
    invites: rows(record.invites).map((row) => ({
      inviteId: text(row.inviteId),
      state: parseInviteState(row.state),
      createdAt: text(row.createdAt),
      expiresAt: text(row.expiresAt),
      usedAt: optionalText(row.usedAt),
      usedByName: optionalText(row.usedByName),
    })),
  };
}

export async function listTeam(actorUserId: string) {
  const result = await adminClient().rpc("admin_list_instructors", { p_actor_id: actorUserId });
  if (result.error) throw new Error(result.error.message);
  return parseTeam(result.data);
}

/** O link com o token puro é devolvido uma única vez; o banco só guarda o hash. */
export async function createInstructorInvite(actorUserId: string) {
  const token = generateInviteToken();
  const result = await adminClient().rpc("admin_create_instructor_invite", {
    p_actor_id: actorUserId,
    p_token_hash: hashInviteToken(token),
    p_valid_days: INVITE_VALID_DAYS,
  });
  if (result.error) throw new Error(result.error.message);
  const data = result.data as { inviteId?: string; expiresAt?: string } | null;
  return { inviteId: text(data?.inviteId), expiresAt: text(data?.expiresAt), url: inviteUrl(token) };
}

export async function revokeInstructorInvite(actorUserId: string, inviteId: string) {
  const result = await adminClient().rpc("admin_revoke_instructor_invite", { p_actor_id: actorUserId, p_invite_id: inviteId });
  if (result.error) throw new Error(result.error.message);
  return result.data === true;
}

export async function setInstructorActive(actorUserId: string, userId: string, active: boolean) {
  const result = await adminClient().rpc("admin_set_instructor_active", { p_actor_id: actorUserId, p_user_id: userId, p_active: active });
  if (result.error) throw new Error(result.error.message);
  return result.data === true;
}

export async function getInviteState(token: string) {
  const result = await adminClient().rpc("instructor_invite_status", { p_token_hash: hashInviteToken(token) });
  if (result.error) throw new Error(result.error.message);
  return parseInviteState(result.data);
}

export function supabaseSignupDeps(): SignupDeps {
  const client = adminClient();
  return {
    async inviteStatus(tokenHash) {
      const result = await client.rpc("instructor_invite_status", { p_token_hash: tokenHash });
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
    async createUser(email, password) {
      // Sem user_metadata/app_metadata: o papel nunca mora no Auth, só em admin_users.
      const result = await client.auth.admin.createUser({ email, password, email_confirm: true });
      if (result.error || !result.data.user) {
        const code = (result.error as { code?: string } | null)?.code ?? "";
        const message = result.error?.message ?? "";
        if (code === "email_exists" || /already (been )?registered|already exists/i.test(message)) return { error: "EMAIL_EXISTS" };
        if (code === "weak_password") return { error: "WEAK_PASSWORD" };
        return { error: "FAILED" };
      }
      return { userId: result.data.user.id };
    },
    async claimInvite(tokenHash, userId, displayName) {
      const result = await client.rpc("instructor_invite_claim", { p_token_hash: tokenHash, p_user_id: userId, p_display_name: displayName });
      if (result.error) throw new Error(result.error.message);
    },
    async deleteUser(userId) {
      const result = await client.auth.admin.deleteUser(userId);
      if (result.error) throw new Error(result.error.message);
    },
    log(stage, details = {}) {
      // Nunca registrar e-mail, senha ou token.
      console.info("[instructor-signup]", { stage, ...details });
    },
  };
}

export function teamErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ADMIN_FORBIDDEN")) return { status: 403, message: "Apenas o administrador pode gerenciar a equipe." };
  if (message.includes("INSTRUCTOR_NOT_FOUND")) return { status: 404, message: "Instrutor não encontrado." };
  if (message.includes("ADMIN_NOT_CONFIGURED")) return { status: 503, message: "Supabase não configurado neste ambiente." };
  if (/instructor|Could not find the function/i.test(message) && /function|relation/i.test(message)) {
    return { status: 503, message: "Aplique a migration de acesso de instrutores no Supabase." };
  }
  return { status: 500, message: "Não foi possível concluir agora. Tente novamente." };
}
