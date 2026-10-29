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
  title: string;
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
  reservation: { eyebrow: string; title: string; ctaLabel: string; image: EditorialImage | null };
};

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
    return { title: need(text(item.title), `Título da informação ${index + 1}`), body, pending };
  });

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
    reservation: {
      eyebrow: text(reservation?.eyebrow),
      title: need(text(reservation?.title), "Título da reserva"),
      ctaLabel: text(reservation?.ctaLabel) || "Garantir minha vaga",
      image: image(reservation?.image),
    },
  };
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

/** O que o visitante lê: informações ainda pendentes só aparecem na prévia. */
export function visibleInfoItems(content: EventContent, preview: boolean) {
  return content.info.items.filter((item) => preview || !item.pending);
}
