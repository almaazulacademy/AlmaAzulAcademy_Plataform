/**
 * Uma edição de evento especial preparada no repositório, antes do cadastro.
 *
 * Cada edição reúne, num só lugar, o que o cadastro grava no banco — slug,
 * título, resumo, base, início, duração, preço, capacidade e o
 * `editorial_content` — e é a fonte única da prévia (`/eventos/demonstracao/[slug]`),
 * da prévia dos e-mails e dos scripts de cadastro gerados
 * (`scripts/events/edition-cadastro-sql.ts`). Nada aqui fala com o banco.
 *
 * As edições ficam registradas no registro de edições (`editions.ts`, nesta pasta).
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import type { BaseLocation } from "../bases/location.ts";
import { validateEventEditorial } from "./editorial.ts";
import { arrivalMatchesSession, isIsoWithOffset } from "./policy.ts";
import type { EventAvailability } from "./presentation.ts";
import type { PublicEvent } from "./public.ts";

/** Reservado para a prévia: um evento com este slug não teria página. */
export const DEMO_SLUG = "demonstracao";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Limites do banco (`admin_create_event` / `admin_create_session`). */
export const EDITION_LIMITS = { capacityMax: 500, durationMax: 24 * 60 } as const;

export type EventEdition = {
  slug: string;
  /** `experiences.title`: também vai para o checkout, a planilha e o assunto do e-mail. */
  title: string;
  summary: string;
  /** Base cadastrada, lida por slug no cadastro. */
  baseSlug: string;
  /** Endereço da base, como cadastrado no banco — só para a prévia. */
  location: BaseLocation;
  /** Início da sessão, ISO 8601 com deslocamento. */
  startsAt: string;
  durationMinutes: number;
  priceCents: number;
  capacity: number;
  /** O `editorial_content` exato que o cadastro grava. */
  editorial: unknown;
  /**
   * Já cadastrada em produção: os scripts dela são os históricos e o gerador
   * genérico recusa gerar outro cadastro (preserva a edição como está).
   */
  registered: boolean;
};

/** O que impede a edição de ser cadastrada. Vazio: pronta. */
export function editionErrors(edition: EventEdition): string[] {
  const errors: string[] = [];
  if (!SLUG.test(edition.slug)) errors.push(`Slug "${edition.slug}" deve usar letras minúsculas, números e hífens.`);
  if (edition.slug === DEMO_SLUG) errors.push(`O slug "${DEMO_SLUG}" é reservado para a prévia.`);
  if (!edition.title.trim()) errors.push("Título obrigatório.");
  if (!edition.summary.trim()) errors.push("Resumo obrigatório.");
  if (!SLUG.test(edition.baseSlug)) errors.push("Base (slug) obrigatória.");
  if (!isIsoWithOffset(edition.startsAt)) errors.push("Início deve ser ISO 8601 com deslocamento, ex.: 2026-11-24T18:00:00.000Z.");
  if (!Number.isInteger(edition.durationMinutes) || edition.durationMinutes < 1 || edition.durationMinutes > EDITION_LIMITS.durationMax) errors.push("Duração deve ser um inteiro de minutos entre 1 e 1440.");
  if (!Number.isInteger(edition.priceCents) || edition.priceCents < 1) errors.push("Preço deve ser um inteiro positivo em centavos.");
  if (!Number.isInteger(edition.capacity) || edition.capacity < 1 || edition.capacity > EDITION_LIMITS.capacityMax) errors.push(`Capacidade deve ser de 1 a ${EDITION_LIMITS.capacityMax}.`);
  if (JSON.stringify(edition.editorial ?? null).includes("$json$")) errors.push("O conteúdo não pode conter o delimitador $json$.");

  const editorial = validateEventEditorial(edition.editorial);
  if (!editorial.success) return [...errors, ...editorial.errors];
  const event = editorial.data.event;
  if (event.reservation.maxPerOrder > edition.capacity) errors.push("O máximo por pedido não pode passar da capacidade.");
  if (isIsoWithOffset(edition.startsAt)) {
    if (event.arrival && !arrivalMatchesSession(event.arrival, edition.startsAt, edition.durationMinutes)) {
      errors.push("A chegada (event.arrival) não combina com o início e a duração da sessão.");
    }
    if (event.cancellation && Date.parse(event.cancellation.deadline) >= Date.parse(edition.startsAt)) {
      errors.push("O prazo de cancelamento precisa ser antes do início.");
    }
  }
  return errors;
}

/** Erros de um conjunto de edições: cada uma válida e nenhum slug repetido. */
export function editionsErrors(editions: readonly EventEdition[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const edition of editions) {
    if (seen.has(edition.slug)) errors.push(`Slug repetido: ${edition.slug}.`);
    seen.add(edition.slug);
    for (const error of editionErrors(edition)) errors.push(`${edition.slug}: ${error}`);
  }
  return errors;
}

/** A edição como a página a recebe, em qualquer situação de vagas, para a prévia. */
export function editionDemoEvent(edition: EventEdition, availability: EventAvailability = "AVAILABLE", remainingSpots = edition.capacity): PublicEvent {
  const editorial = validateEventEditorial(edition.editorial);
  if (!editorial.success) throw new Error(`Conteúdo de ${edition.slug} inválido: ${editorial.errors.join("; ")}`);
  return {
    id: `demonstracao-${edition.slug}`,
    slug: edition.slug,
    title: edition.title,
    summary: edition.summary,
    editorial: editorial.data,
    location: edition.location,
    session: {
      id: null,
      startsAt: edition.startsAt,
      durationMinutes: edition.durationMinutes,
      priceCents: edition.priceCents,
      remainingSpots: availability === "AVAILABLE" ? remainingSpots : availability === "SOLD_OUT" ? 0 : null,
      availability,
    },
  };
}
