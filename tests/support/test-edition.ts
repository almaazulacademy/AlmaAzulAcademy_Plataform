/**
 * Uma edição de evento só para os testes do registro de edições (PR A da 2ª
 * edição do ESSÊNCIA): tarde, sem alimentação, com um benefício próprio no
 * e-mail e as reservas "em breve". Não é a 2ª edição real — o conteúdo dela
 * chega no PR B — e não é registrada em `lib/events/editions.ts`.
 *
 * Parte do conteúdo aprovado da 1ª edição (Hero, SEO, parceiros, fotos do
 * repositório) e troca o que uma edição nova troca.
 */

import { CONCHA_ACUSTICA_LOCATION, ESSENCIA_EDITORIAL } from "../../lib/events/fixtures/essencia.ts";
import type { EventEdition } from "../../lib/events/edition.ts";

type Editorial = Record<string, unknown> & { event: Record<string, unknown> & { info: { items: Array<Record<string, unknown>> }; reservation: Record<string, unknown> } };

export function testEditorial(): Editorial {
  const editorial = JSON.parse(JSON.stringify(ESSENCIA_EDITORIAL)) as Editorial;
  const event = editorial.event;
  event.badge = "Evento especial · edição de teste";
  event.subtitle = "Uma tarde de teste";
  event.scheduleLabel = "A partir das 15h";
  event.program = {
    eyebrow: "Programação",
    title: "Da tarde à noite.",
    items: [
      { time: "15:00", title: "Recepção", description: "Boas-vindas.", hosts: [] },
      {
        time: "15:30",
        title: "Prática guiada",
        description: "Movimento e respiração.",
        hosts: ["Equipe de teste"],
        image: { src: "/images/eventos/essencia/capsula-deck-lago.jpg", alt: "Deck do Cápsula Bar", credit: "Registro de uma edição anterior · teste" },
      },
      { time: "17:30", title: "Remada", description: "Remada no fim da tarde.", hosts: ["Alma Azul Academy"] },
    ],
  };
  event.included = { eyebrow: "Ingresso único", title: "O que está incluso.", items: ["Prática guiada", "Remada", "Brinde de cortesia"] };
  event.info.items = [
    { id: "chegada", title: "Horário e chegada", body: "Começamos às 15h00. Tolerância de chegada até 15h20." },
    { id: "o-que-levar", title: "O que levar", body: "Roupas confortáveis e garrafa de água." },
    { id: "experiencia", title: "Preciso ter experiência?", body: "Não é preciso experiência anterior." },
    { id: "seguranca", title: "Segurança na água", body: "Colete salva-vidas obrigatório na remada." },
    { id: "brinde", title: "Brinde de cortesia", body: "Cada participante recebe um brinde de cortesia do local.", email: true },
    { id: "clima", title: "Condições climáticas", body: "Com tempo inseguro, a atividade na água pode ser substituída.", email: false },
    { id: "cancelamento", title: "Política de cancelamento", body: "Cancelamento até 10 de dezembro de 2026, às 12h00 (horário de Brasília)." },
  ];
  event.arrival = { startTime: "15:00", toleranceUntil: "15:20" };
  event.cancellation = { deadline: "2026-12-10T12:00:00-03:00", timeZone: "America/Sao_Paulo", summary: "crédito ou reembolso" };
  event.reservation = { ...event.reservation, notice: null, comingSoon: true };
  delete event.reservation.notice;
  return editorial;
}

/** 12/12/2026, 15h em Brasília: depois do relógio dos roteiros (31/10/2026). */
export const TEST_EDITION: EventEdition = {
  slug: "evento-teste-tarde",
  title: "Evento de teste — Uma tarde",
  summary: "Edição usada só pelos testes do registro de edições.",
  baseSlug: "concha-acustica",
  location: CONCHA_ACUSTICA_LOCATION,
  startsAt: "2026-12-12T18:00:00.000Z",
  durationMinutes: 240,
  priceCents: 15_000,
  capacity: 24,
  editorial: testEditorial(),
  registered: false,
};
