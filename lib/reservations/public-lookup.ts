/**
 * Consulta pública da reserva (`/api/reservations/lookup`): CPF + código.
 *
 * O contrato é o de sempre — 400 com `errors`, 404, 200 com `reservation`,
 * 500 —, com uma resposta a mais: 429, com `Retry-After`, para quem passar do
 * limite de tentativas. O limite é o mesmo do autoatendimento de Stand-by, nos
 * mesmos baldes: o código tentado aqui conta lá, e vice-versa.
 *
 * **A consulta nunca fica fora do ar por causa do limite.** Ela existia sem
 * limite e é o caminho de todo cliente para acompanhar a reserva. Se a função
 * do limite não existir (código publicado antes da migration) ou não responder,
 * a consulta segue exatamente como era. O autoatendimento, que é novo, faz o
 * contrário e fecha.
 *
 * Nada da credencial vai para log: só um símbolo curto do que falhou.
 */

import { registerAccessAttempt, TOO_MANY_ATTEMPTS_MESSAGE, type AccessRpc } from "./access-throttle.ts";
import type { ReservationDetails } from "./types.ts";
import { validateLookupInput } from "./validation.ts";

export type PublicLookupDeps = {
  rpc: AccessRpc;
  lookup(cpf: string, publicCode: string): Promise<ReservationDetails | null>;
  /** Registro de falhas. Recebe só símbolos, nunca CPF, código ou mensagem do banco. */
  logFailure?(symbol: string): void;
};

export type PublicLookupResponse = { status: number; body: Record<string, unknown>; retryAfterSeconds?: number };

export const LOOKUP_MESSAGES = {
  NOT_FOUND: "Reserva não encontrada. Confira o CPF e o código.",
  FAILED: "Não foi possível consultar a reserva agora.",
  TOO_MANY_ATTEMPTS: TOO_MANY_ATTEMPTS_MESSAGE,
} as const;

/** Um símbolo do banco (`[A-Z0-9_]`) passa; qualquer outro texto vira um genérico. */
export function lookupFailureSymbol(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : "";
  return /^[A-Z0-9_]{1,64}$/.test(message) ? message : "LOOKUP_FAILED";
}

export async function handlePublicLookup(deps: PublicLookupDeps, body: unknown, clientAddress: string): Promise<PublicLookupResponse> {
  const validation = validateLookupInput(body);
  if (!validation.success) return { status: 400, body: { errors: validation.errors } };
  const { cpf, publicCode } = validation.data;

  const attempt = await registerAccessAttempt(deps.rpc, clientAddress, { p_cpf: cpf, p_public_code: publicCode, p_link_token: null });
  if (attempt.status === "BLOCKED") {
    return { status: 429, body: { message: LOOKUP_MESSAGES.TOO_MANY_ATTEMPTS }, retryAfterSeconds: attempt.retryAfterSeconds };
  }
  // Antes da migration a função não existe: a consulta segue como sempre foi,
  // sem registro a cada chamada. Qualquer outra falha do limite é registrada.
  if (attempt.status === "UNAVAILABLE" && attempt.reason === "ERROR") deps.logFailure?.("ACCESS_THROTTLE_UNAVAILABLE");

  try {
    const reservation = await deps.lookup(cpf, publicCode);
    if (!reservation) return { status: 404, body: { message: LOOKUP_MESSAGES.NOT_FOUND } };
    return { status: 200, body: { reservation } };
  } catch (error) {
    deps.logFailure?.(lookupFailureSymbol(error));
    return { status: 500, body: { message: LOOKUP_MESSAGES.FAILED } };
  }
}
