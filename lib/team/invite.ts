import { createHash, randomBytes } from "node:crypto";

import { resolveCheckinOrigin } from "../checkin/origin.ts";

export * from "./invite-rules.ts";

/**
 * Convite de instrutor.
 *
 * O token tem 32 bytes aleatórios (256 bits, base64url) e só existe no link
 * entregue ao administrador. O banco guarda apenas o SHA-256 dele, então nem um
 * vazamento da tabela permite montar um link válido.
 */

export const INVITE_VALID_DAYS = 7;
export const INVITE_PATH = "/instrutor/cadastro";

export function generateInviteToken() {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function inviteUrl(token: string, origin = resolveCheckinOrigin()) {
  return `${origin}${INVITE_PATH}?invite=${encodeURIComponent(token)}`;
}
