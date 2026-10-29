/**
 * Conteúdo editorial de um evento especial.
 *
 * Um evento é uma experiência `kind = 'EVENT'`, então o documento continua
 * sendo `experiences.editorial_content` versão 1 — Hero, SEO e as seções que a
 * publicação no banco já exige (`experience_editorial_is_publishable`). O que
 * só o evento tem fica num bloco a mais, `event`: apresentação, programação,
 * o que está incluso, quem faz acontecer, informações importantes e reserva.
 *
 * Nada da página de evento é fixado no código: outro evento usa o mesmo modelo
 * só com outro conteúdo. Este módulo valida e normaliza o bloco; um evento sem
 * o bloco completo não aparece no site.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import { isEditorialImageSource, validateExperienceEditorial, type EditorialImage, type ExperienceEditorial } from "../editorial/experience.ts";
import {
  clockText,
  deadlineDayText,
  deadlineTimeText,
  isClockTime,
  isIsoWithOffset,
  POLICY_TIME_ZONE,
  type EventArrival,
  type EventCancellation,
} from "./policy.ts";

export type EventProgramItem = {
  /** "05:30", no horário de Brasília. */
  time: string;
  title: string;
  description: string;
  /** Quem conduz, como informado pela organização. */
  hosts: string[];
  /** Observação curta em destaque, ex.: "Não é necessário ter experiência prévia." */
  note: string | null;
  image: EditorialImage | null;
};

export type EventPartner = {
  name: string;
  /** O que o parceiro faz no evento, nas palavras da organização. */
  role: string | null;
  logo: EditorialImage | null;
};

export type EventInfoItem = {
  /** Âncora estável (`#info-<id>`). `chegada` e `cancelamento` são conferidos com as regras do evento. */
  id: string | null;
  title: string;
  /** Parágrafos separados por linha em branco. */
  body: string | null;
  /** Texto ainda não confirmado pela equipe: nunca aparece num evento publicado. */
  pending: boolean;
};

export type EventContent = {
  badge: string;
  subtitle: string;
  tagline: string;
  highlights: string[];
  /** Foto do Hero para telas estreitas; sem ela, usa a do Hero. */
  heroImageMobile: EditorialImage | null;
  /** Foto do card na listagem; sem ela, usa a do Hero. */
  cardImage: EditorialImage | null;
  intro: { eyebrow: string; title: string; paragraphs: string[]; image: EditorialImage | null };
  program: { eyebrow: string; title: string; items: EventProgramItem[] };
  included: { eyebrow: string; title: string; description: string | null; items: string[] };
  partners: { eyebrow: string; title: string; items: EventPartner[] };
  info: { eyebrow: string; title: string; items: EventInfoItem[] };
  /** Início e tolerância de chegada. Opcional: sem ele, a página não fala de tolerância. */
  arrival: EventArrival | null;
  /** Prazo de cancelamento inequívoco. Opcional; com ele, o texto `cancelamento` é obrigatório. */
  cancellation: EventCancellation | null;
  reservation: {
    eyebrow: string;
    title: string;
    ctaLabel: string;
    image: EditorialImage | null;
    /** Máximo de participantes por pedido, de 1 a 20. Sem ele, o limite geral (20). */
    maxPerOrder: number;
    /**
     * Orientação curta do resumo antes do pagamento, depois de "Importante:".
     * Opcional: sem ela, o resumo não mostra aviso nenhum.
     */
    notice: string | null;
  };
};

/** O limite geral de uma reserva, o mesmo de `create_pre_reservation`. */
export const RESERVATION_MAX_QUANTITY = 20;

export type EventEditorial = ExperienceEditorial & { event: EventContent };

type Validation = { success: true; data: EventEditorial } | { success: false; errors: string[] };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function texts(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function image(value: unknown): EditorialImage | null {
  const item = record(value);
  const src = text(item?.src);
  const alt = text(item?.alt);
  if (!src || !alt || !isEditorialImageSource(src)) return null;
  const credit = text(item?.credit);
  return credit ? { src, alt, credit } : { src, alt };
}

function list(value: unknown) {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
}

/** Só o bloco `event`, já normalizado, ou a lista do que falta. */
export function parseEventContent(value: unknown): { content: EventContent | null; errors: string[] } {
  const root = record(value);
  if (!root) return { content: null, errors: ["O bloco event é obrigatório num evento especial."] };
  const errors: string[] = [];
  const need = (valueText: string, label: string) => {
    if (!valueText) errors.push(`${label} é obrigatório.`);
    return valueText;
  };

  const intro = record(root.intro);
  const program = record(root.program);
  const included = record(root.included);
  const partners = record(root.partners);
  const info = record(root.info);
  const reservation = record(root.reservation);

  const programItems = list(program?.items).map((item, index): EventProgramItem => {
    const time = text(item.time);
    if (!TIME.test(time)) errors.push(`Horário ${index + 1} da programação deve ser HH:MM.`);
    return {
      time,
      title: need(text(item.title), `Título da atividade ${index + 1}`),
      description: need(text(item.description), `Descrição da atividade ${index + 1}`),
      hosts: texts(item.hosts),
      note: text(item.note) || null,
      image: image(item.image),
    };
  });
  if (!programItems.length) errors.push("A programação precisa de pelo menos uma atividade.");
  for (let index = 1; index < programItems.length; index += 1) {
    if (programItems[index].time < programItems[index - 1].time) errors.push("A programação deve estar em ordem de horário.");
  }

  const partnerItems = list(partners?.items).map((item, index): EventPartner => ({
    name: need(text(item.name), `Nome do parceiro ${index + 1}`),
    role: text(item.role) || null,
    logo: image(item.logo),
  }));

  const infoItems = list(info?.items).map((item, index): EventInfoItem => {
    const body = text(item.body) || null;
    const pending = item.pending === true || !body;
    const id = text(item.id);
    if (id && !/^[a-z0-9-]+$/.test(id)) errors.push(`Identificador da informação ${index + 1} deve usar letras minúsculas, números e hífen.`);
    return { id: id || null, title: need(text(item.title), `Título da informação ${index + 1}`), body, pending };
  });
  const infoById = (id: string) => infoItems.find((item) => item.id === id && !item.pending) ?? null;

  const arrivalRecord = record(root.arrival);
  let arrival: EventArrival | null = null;
  if (arrivalRecord) {
    const startTime = text(arrivalRecord.startTime);
    const toleranceUntil = text(arrivalRecord.toleranceUntil);
    if (!isClockTime(startTime) || !isClockTime(toleranceUntil)) errors.push("Início e tolerância de chegada devem ser HH:MM.");
    else if (toleranceUntil <= startTime) errors.push("A tolerância de chegada deve ser depois do início.");
    else {
      arrival = { startTime, toleranceUntil };
      // O texto publicado diz os mesmos horários da regra.
      const body = infoById("chegada")?.body ?? "";
      if (!body.includes(clockText(startTime)) || !body.includes(clockText(toleranceUntil))) {
        errors.push(`O texto "chegada" precisa citar ${clockText(startTime)} e ${clockText(toleranceUntil)}.`);
      }
    }
  }

  const cancellationRecord = record(root.cancellation);
  let cancellation: EventCancellation | null = null;
  if (cancellationRecord) {
    const deadline = text(cancellationRecord.deadline);
    const timeZone = text(cancellationRecord.timeZone);
    const summary = text(cancellationRecord.summary);
    if (!isIsoWithOffset(deadline)) errors.push("O prazo de cancelamento deve ser ISO 8601 com deslocamento, ex.: 2026-11-05T12:00:00-03:00.");
    else if (timeZone !== POLICY_TIME_ZONE) errors.push(`O fuso do prazo de cancelamento deve ser ${POLICY_TIME_ZONE}.`);
    else if (!summary) errors.push("O resumo da política de cancelamento é obrigatório.");
    else {
      cancellation = { deadline, timeZone: POLICY_TIME_ZONE, summary };
      // O texto publicado diz o mesmo prazo da regra.
      const body = infoById("cancelamento")?.body ?? "";
      if (!body.includes(deadlineDayText(deadline)) || !body.includes(deadlineTimeText(deadline))) {
        errors.push(`O texto "cancelamento" precisa citar ${deadlineDayText(deadline)} e ${deadlineTimeText(deadline)}.`);
      }
    }
  }

  const includedItems = texts(included?.items);
  if (!includedItems.length) errors.push("O que está incluso precisa de pelo menos um item.");

  const content: EventContent = {
    badge: need(text(root.badge), "Selo do evento"),
    subtitle: need(text(root.subtitle), "Subtítulo do evento"),
    tagline: need(text(root.tagline), "Descrição do Hero do evento"),
    highlights: texts(root.highlights),
    heroImageMobile: image(root.heroImageMobile),
    cardImage: image(root.cardImage),
    intro: {
      eyebrow: text(intro?.eyebrow),
      title: need(text(intro?.title), "Título da apresentação"),
      paragraphs: texts(intro?.paragraphs),
      image: image(intro?.image),
    },
    program: { eyebrow: text(program?.eyebrow), title: need(text(program?.title), "Título da programação"), items: programItems },
    included: {
      eyebrow: text(included?.eyebrow),
      title: need(text(included?.title), "Título do que está incluso"),
      description: text(included?.description) || null,
      items: includedItems,
    },
    partners: { eyebrow: text(partners?.eyebrow), title: text(partners?.title) || "Quem faz acontecer", items: partnerItems },
    info: { eyebrow: text(info?.eyebrow), title: text(info?.title) || "Informações importantes", items: infoItems },
    arrival,
    cancellation,
    reservation: {
      eyebrow: text(reservation?.eyebrow),
      title: need(text(reservation?.title), "Título da reserva"),
      ctaLabel: text(reservation?.ctaLabel) || "Garantir minha vaga",
      image: image(reservation?.image),
      maxPerOrder: RESERVATION_MAX_QUANTITY,
      notice: text(reservation?.notice) || null,
    },
  };
  if (content.reservation.notice && content.reservation.notice.length > 200) errors.push("A orientação do resumo da reserva deve ter até 200 caracteres.");
  if (reservation?.maxPerOrder !== undefined) {
    const max = Number(reservation.maxPerOrder);
    if (!Number.isInteger(max) || max < 1 || max > RESERVATION_MAX_QUANTITY) errors.push(`O máximo de participantes por pedido deve ser de 1 a ${RESERVATION_MAX_QUANTITY}.`);
    else content.reservation.maxPerOrder = max;
  }
  if (!content.intro.paragraphs.length) errors.push("A apresentação precisa de pelo menos um parágrafo.");

  return errors.length ? { content: null, errors } : { content, errors: [] };
}

/** O documento inteiro: a parte comum às experiências e o bloco do evento. */
export function validateEventEditorial(value: unknown): Validation {
  const base = validateExperienceEditorial(value, true);
  const event = parseEventContent(record(value)?.event);
  const errors = [...(base.success ? [] : base.errors), ...event.errors];
  if (!base.success || !event.content) return { success: false, errors };
  return { success: true, data: { ...base.data, event: event.content } };
}

/** Parágrafos de um texto de informação (separados por linha em branco). */
export function infoParagraphs(body: string | null) {
  return (body ?? "").split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

/** O que o visitante lê: informações ainda pendentes só aparecem na prévia. */
export function visibleInfoItems(content: EventContent, preview: boolean) {
  return content.info.items.filter((item) => preview || !item.pending);
}
