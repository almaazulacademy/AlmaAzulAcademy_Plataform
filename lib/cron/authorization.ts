/**
 * Autenticação das rotas acionadas por agendador.
 *
 * O Vercel Cron invoca o caminho configurado por **GET** e, quando existe a
 * variável `CRON_SECRET` no projeto, envia o valor automaticamente no cabeçalho
 * `Authorization: Bearer <CRON_SECRET>`. Não é preciso configurar nada além da
 * variável — o cabeçalho é acrescentado pela plataforma.
 *
 * Sem imports de aplicação de propósito: assim a regra pode ser testada com uma
 * `Request` real, montada exatamente como o agendador a envia.
 */

import { timingSafeEqual } from "node:crypto";

export const BEARER_PREFIX = "Bearer ";

/**
 * true quando a requisição traz o segredo correto.
 *
 * A comparação é de tempo constante: um `===` sobre segredo vaza informação por
 * temporização, e este endpoint é público. Sem segredo configurado nada é
 * autorizado — um endpoint que não tem como se autenticar não deve rodar.
 */
export function isAuthorizedCronRequest(request: Request, secret: string | undefined | null) {
  const expected = (secret ?? "").trim();
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith(BEARER_PREFIX)) return false;

  const offered = header.slice(BEARER_PREFIX.length);
  const offeredBytes = Buffer.from(offered, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  // timingSafeEqual exige o mesmo comprimento; comparar antes não vaza mais do
  // que o próprio tamanho da resposta já vazaria.
  if (offeredBytes.length !== expectedBytes.length) return false;

  return timingSafeEqual(offeredBytes, expectedBytes);
}
