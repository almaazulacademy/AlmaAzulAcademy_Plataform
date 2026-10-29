/**
 * Eventos especiais — etapa 5C-1: lista de espera do evento, com escopo próprio.
 *
 * Não há segunda lista: a inscrição é a de sempre (`POST /api/waitlist` →
 * `waitlist_join`), com a mesma validação, o mesmo limite de tentativas, o
 * mesmo campo isca e a mesma fila. O que este módulo decide, no servidor e
 * antes do banco, é **se aquela sessão pode receber inscrição agora**:
 *
 *   - sessão de experiência regular segue a variável de sempre
 *     (`WAITLIST_SIGNUP_ENABLED` + `WAITLIST_PUBLIC_ENABLED`);
 *   - sessão de evento segue só `EVENTS_WAITLIST_ENABLED` (com a venda do
 *     evento aberta), e só se o evento estiver publicado no site com esta
 *     sessão como a edição em destaque;
 *   - o pedido respeita o máximo por pedido do evento (6 no ESSÊNCIA).
 *
 * Ligar uma das variáveis nunca abre a inscrição do outro tipo. O tipo vem do
 * banco (`experiences.kind`), lido com a service role — nunca do navegador.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import { validateEventEditorial } from "./editorial.ts";
import { eventOrderLimitMessage, type RulesQueryClient } from "./booking.ts";
import { mapPublicEvent } from "./public.ts";

export type WaitlistTarget = { kind: "REGULAR" } | { kind: "EVENT"; slug: string; maxPerOrder: number };

/** O que a inscrição faz com a sessão pedida. */
export type WaitlistScope =
  | { kind: "REGULAR" }
  | { kind: "EVENT"; slug: string; maxPerOrder: number }
  /** Variável do tipo desligada: 404, como se a inscrição não existisse. */
  | { kind: "DISABLED" }
  /** Evento fora do site (não publicado, outra edição, conteúdo inválido): 409. */
  | { kind: "SESSION_UNAVAILABLE" }
  /** Sem conseguir saber o tipo: 503, nunca inscrição às cegas. */
  | { kind: "UNAVAILABLE" };

type QueryResult = { data: unknown; error: { message: string; code?: string } | null };

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

/**
 * Tipo da sessão, com o slug e o máximo por pedido do evento. Sessão
 * inexistente: null. Banco sem a coluna `kind`: regular. Outra falha lança.
 */
export async function loadWaitlistTarget(client: RulesQueryClient, sessionId: string): Promise<WaitlistTarget | null> {
  const session: QueryResult = await client.from("sessions").select("experience_id").eq("id", sessionId);
  if (session.error) throw new Error(`WAITLIST_TARGET_FAILED: ${session.error.message}`);
  const experienceId = firstRow(session.data)?.experience_id;
  if (typeof experienceId !== "string" || !experienceId) return null;

  const experience: QueryResult = await client.from("experiences").select("kind, slug, editorial_content").eq("id", experienceId);
  if (experience.error) {
    if (experience.error.code === "42703" || /column .*kind.* does not exist/i.test(experience.error.message)) return { kind: "REGULAR" };
    throw new Error(`WAITLIST_TARGET_FAILED: ${experience.error.message}`);
  }
  const row = firstRow(experience.data);
  if (row?.kind !== "EVENT") return { kind: "REGULAR" };
  const editorial = validateEventEditorial(row.editorial_content);
  return { kind: "EVENT", slug: String(row.slug ?? ""), maxPerOrder: editorial.success ? editorial.data.event.reservation.maxPerOrder : 20 };
}

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<QueryResult>;

/**
 * O evento está no site com esta sessão como a edição em destaque? É a mesma
 * leitura da página (`get_public_event`): evento publicado, interruptor de
 * publicação ligado e conteúdo válido. Falha de leitura lança.
 */
export async function isEventWaitlistVisible(rpc: Rpc, slug: string, sessionId: string) {
  if (!slug) return false;
  const result = await rpc("get_public_event", { p_slug: slug });
  if (result.error) throw new Error(`WAITLIST_EVENT_FAILED: ${result.error.message}`);
  const event = mapPublicEvent(Array.isArray(result.data) ? result.data[0] : result.data);
  return Boolean(event && event.session.id === sessionId);
}

export type WaitlistScopeDeps = {
  loadTarget: (sessionId: string) => Promise<WaitlistTarget | null>;
  eventVisible: (slug: string, sessionId: string) => Promise<boolean>;
  regularEnabled: boolean;
  eventsEnabled: boolean;
};

/**
 * Decide o escopo da inscrição. A variável de cada tipo só vale para o seu
 * tipo; sessão desconhecida segue para o banco só se a inscrição regular
 * estiver ligada (é ele quem responde "turma indisponível").
 */
export async function resolveWaitlistScope(deps: WaitlistScopeDeps, sessionId: string): Promise<WaitlistScope> {
  let target: WaitlistTarget | null;
  try {
    target = await deps.loadTarget(sessionId);
  } catch {
    return { kind: "UNAVAILABLE" };
  }
  if (!target || target.kind === "REGULAR") return deps.regularEnabled ? { kind: "REGULAR" } : { kind: "DISABLED" };
  if (!deps.eventsEnabled) return { kind: "DISABLED" };
  try {
    if (!(await deps.eventVisible(target.slug, sessionId))) return { kind: "SESSION_UNAVAILABLE" };
  } catch {
    return { kind: "UNAVAILABLE" };
  }
  return target;
}

/** Textos da inscrição num evento: "evento" e "ingresso", nunca "turma". */
export const EVENT_WAITLIST_MESSAGES = {
  ACCEPTED: "Inscrição recebida. Se este e-mail ainda não estava na lista de espera deste evento, a confirmação chega em instantes, com o link para sair da lista quando quiser.",
  SESSION_UNAVAILABLE: "Este evento não está aberto para a lista de espera.",
  NOT_SOLD_OUT: "Boa notícia: este evento tem vagas agora. Você pode garantir seu ingresso direto.",
  LIMIT_REACHED: "Este e-mail já está em muitas listas de espera. Saia de alguma delas antes de entrar em outra.",
  WAITLIST_FULL: "A lista de espera deste evento está cheia.",
} as const;

export function eventWaitlistQuantityMessage(maxPerOrder: number) {
  return eventOrderLimitMessage(maxPerOrder);
}

/** Texto do evento esgotado, na página do evento e na página da lista. */
export const EVENT_SOLD_OUT_TITLE = "Evento esgotado";
export const EVENT_WAITLIST_INVITE = "Todas as vagas desta edição foram preenchidas. Entre para a lista de espera e seja avisado caso surja uma oportunidade.";
export const EVENT_WAITLIST_CTA = "Entrar na lista de espera";
