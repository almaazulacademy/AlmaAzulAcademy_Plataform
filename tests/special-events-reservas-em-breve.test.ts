/**
 * Evento aguardando a abertura comercial: com `EVENT_BOOKING_OPEN` desligada, a
 * página nunca diz "Reservas encerradas". A variável separa "ainda não abriu" de
 * "encerrou", e nada disso alcança as experiências regulares.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { availabilityBadge, eventCta, spotsLabel, type EventAvailability } from "../lib/events/presentation.ts";

const TITLE = "Reservas abrem em breve";
const NOTE = "Estamos preparando os últimos detalhes desta experiência. Em breve, você poderá garantir sua vaga!";

function cta(availability: EventAvailability, bookingOpen: boolean, waitlistHref: string | null = null) {
  return eventCta({ availability, sessionId: "s-1", ctaLabel: "Garantir minha vaga", bookingOpen, waitlistHref });
}

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("venda desligada, sessão fechada: abre em breve, sem link e sem 'encerradas'", () => {
  assert.deepEqual(cta("CLOSED", false), { kind: "SOON", label: TITLE, note: NOTE });
  assert.deepEqual(availabilityBadge("CLOSED", null, false), { label: TITLE, tone: "open" });
  assert.doesNotMatch(JSON.stringify([cta("CLOSED", false), availabilityBadge("CLOSED", null, false)]), /encerrad/i);
});

test("venda desligada, sessão aberta com vagas: abre em breve, sem 'Vagas abertas' e sem link", () => {
  assert.deepEqual(cta("AVAILABLE", false), { kind: "SOON", label: TITLE, note: NOTE });
  assert.equal(availabilityBadge("AVAILABLE", 24, false).label, TITLE);
  assert.equal(availabilityBadge("AVAILABLE", 2, false).label, TITLE);
});

test("venda ligada, sessão fechada: continua 'Reservas encerradas'", () => {
  assert.deepEqual(cta("CLOSED", true), { kind: "UNAVAILABLE", label: "Reservas encerradas", note: "As reservas para esta edição foram encerradas." });
  assert.equal(availabilityBadge("CLOSED", null, true).label, "Reservas encerradas");
});

test("venda ligada, sessão aberta: reserva e contagem de sempre", () => {
  assert.deepEqual(cta("AVAILABLE", true), { kind: "BOOK", label: "Garantir minha vaga", href: "/reservar/s-1" });
  assert.equal(availabilityBadge("AVAILABLE", 24, true).label, "Vagas abertas");
  assert.equal(availabilityBadge("AVAILABLE", 2, true).label, "Últimas 2 vagas");
  assert.deepEqual(eventCta({ availability: "AVAILABLE", sessionId: null, ctaLabel: "x", bookingOpen: true }), { kind: "SOON", label: TITLE, note: NOTE }, "sem sessão, nada a reservar");
});

test("esgotado continua esgotado, com a venda ligada ou desligada", () => {
  for (const bookingOpen of [false, true]) {
    assert.deepEqual(cta("SOLD_OUT", bookingOpen), { kind: "UNAVAILABLE", label: "Esgotado", note: "Todas as vagas desta edição foram reservadas." });
    assert.equal(availabilityBadge("SOLD_OUT", 0, bookingOpen).label, "Esgotado");
  }
  assert.equal(spotsLabel("SOLD_OUT", 0), "Esgotado");
  assert.equal(cta("SOLD_OUT", true, "/lista-de-espera/s-1").kind, "WAITLIST");
});

test("realizado, cancelado e sem data não mudam com a variável", () => {
  const expected: Array<[EventAvailability, string]> = [["ENDED", "Evento realizado"], ["CANCELLED", "Evento cancelado"], ["NO_SESSION", "Data a confirmar"]];
  for (const [availability, label] of expected) {
    for (const bookingOpen of [false, true]) {
      assert.equal(cta(availability, bookingOpen).label, label);
      assert.equal(availabilityBadge(availability, null, bookingOpen).label, label);
      assert.equal(cta(availability, bookingOpen).kind, "UNAVAILABLE");
    }
  }
});

test("todo ponto da interface recebe a variável real", () => {
  assert.match(source("app/page.tsx"), /<EventHighlight event=\{nextEvent\} bookingOpen=\{isEventBookingOpen\(\)\} \/>/);
  assert.match(source("app/eventos/page.tsx"), /<EventsIndex upcoming=\{upcoming\} past=\{past\} bookingOpen=\{isEventBookingOpen\(\)\} \/>/);
  assert.match(source("app/eventos/[slug]/page.tsx"), /bookingOpen=\{isEventBookingOpen\(\)\}/);
  for (const file of ["event-page", "event-card", "event-highlight"]) {
    assert.match(source(`components/events/${file}.tsx`), /<AvailabilityBadge [^>]*bookingOpen=\{bookingOpen\}/, file);
  }
  assert.equal((source("components/events/events-index.tsx").match(/<EventCard [^>]*bookingOpen=\{bookingOpen\}/g) ?? []).length, 3);
});

test("experiências regulares não usam nada disso: selo e botão só existem nas telas de evento", () => {
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && /\b(availabilityBadge|eventCta|AvailabilityBadge|EventCtaButton)\b/.test(readFileSync(path, "utf8"))) importers.push(path);
    }
  };
  for (const root of ["app", "components", "lib"]) walk(new URL(`../${root}`, import.meta.url).pathname);
  assert.ok(importers.length > 0);
  for (const path of importers) assert.match(path, /\/(components\/events|lib\/events|app\/eventos)\//, path);
});
