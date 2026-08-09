import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SESSION_FILTERS,
  applySessionFilters,
  hasSessionFilters,
  sessionFiltersFrom,
  sessionListFilterFor,
  sessionSearchParams,
} from "../lib/admin/session-filters.ts";
import type { AdminSession, AdminSessionFilters, SessionLifecycleStatus } from "../lib/admin/types.ts";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function session(id: string, experienceTitle: string, startsAt: string, status: SessionLifecycleStatus): AdminSession {
  return {
    id,
    experienceId: `exp-${experienceTitle.toLowerCase().replace(/\s/g, "-")}`,
    experienceTitle,
    startsAt,
    durationMinutes: 90,
    priceCents: 15000,
    capacity: 10,
    remainingSpots: 4,
    reservationsCount: 3,
    status,
    internalNotes: null,
    createdAt: startsAt,
    updatedAt: startsAt,
    participants: [],
  };
}

const paranoa = session("s1", "Imersão Paranoá", "2026-09-10T18:00:00.000Z", "OPEN");
const sunset = session("s2", "Remada Sunset", "2026-08-01T21:00:00.000Z", "CLOSED");
const nascerDoSol = session("s3", "Remada do Nascer do Sol", "2026-12-01T09:00:00.000Z", "CANCELLED");
const luaCheia = session("s4", "Remada da Lua Cheia", "2026-07-01T22:00:00.000Z", "ARCHIVED");
const canoa = session("s5", "Aula de Canoa Havaiana", "2026-08-09T20:00:00.000Z", "OPEN");
const all = [paranoa, sunset, nascerDoSol, luaCheia, canoa];

function filters(overrides: Partial<AdminSessionFilters> = {}): AdminSessionFilters {
  return { ...DEFAULT_SESSION_FILTERS, ...overrides };
}

function ids(sessions: AdminSession[]) {
  return sessions.map((item) => item.id);
}

test("busca pelo nome da experiência ignora acentos e caixa", () => {
  assert.deepEqual(ids(applySessionFilters(all, filters({ query: "imersao paranoa" }), NOW)), ["s1"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ query: "REMADA SUNSET" }), NOW)), ["s2"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ query: "remada" }), NOW)), ["s3", "s2"]);
});

test("busca também encontra pela data e pelo horário exibidos", () => {
  assert.deepEqual(ids(applySessionFilters(all, filters({ query: "10/09/2026" }), NOW)), ["s1"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ query: "2026-09-10" }), NOW)), ["s1"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ query: "setembro" }), NOW)), ["s1"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ query: "18:00" }), NOW)), ["s2"]);
});

test("não busca por identificadores técnicos", () => {
  assert.deepEqual(applySessionFilters(all, filters({ query: "s1" }), NOW), []);
  assert.deepEqual(applySessionFilters(all, filters({ query: "exp-imersão-paranoá" }), NOW), []);
});

test("status separa ativas, abertas, fechadas, canceladas, arquivadas e todas", () => {
  assert.deepEqual(ids(applySessionFilters(all, filters({ status: "ACTIVE" }), NOW)), ["s5", "s1", "s3", "s2"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ status: "OPEN" }), NOW)), ["s5", "s1"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ status: "CLOSED" }), NOW)), ["s2"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ status: "CANCELLED" }), NOW)), ["s3"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ status: "ARCHIVED" }), NOW)), ["s4"]);
  assert.equal(applySessionFilters(all, filters({ status: "ALL" }), NOW).length, 5);
});

test("o filtro de status usa a RPC existente apenas para o recorte de arquivamento", () => {
  assert.equal(sessionListFilterFor("ACTIVE"), "ACTIVE");
  assert.equal(sessionListFilterFor("OPEN"), "ACTIVE");
  assert.equal(sessionListFilterFor("CLOSED"), "ACTIVE");
  assert.equal(sessionListFilterFor("CANCELLED"), "ACTIVE");
  assert.equal(sessionListFilterFor("ARCHIVED"), "ARCHIVED");
  assert.equal(sessionListFilterFor("ALL"), "ALL");
});

test("filtra por experiência e por período no fuso de Brasília", () => {
  assert.deepEqual(ids(applySessionFilters(all, filters({ experienceId: paranoa.experienceId }), NOW)), ["s1"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ period: "UPCOMING" }), NOW)), ["s5", "s1", "s3"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ period: "PAST", status: "ALL" }), NOW)), ["s2", "s4"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ period: "TODAY" }), NOW)), ["s5"]);
});

test("aceita intervalo personalizado de datas", () => {
  assert.deepEqual(ids(applySessionFilters(all, filters({ from: "2026-08-01", to: "2026-08-31", status: "ALL" }), NOW)), ["s5", "s2"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ from: "2026-10-01", status: "ALL" }), NOW)), ["s3"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ to: "2026-07-31", status: "ALL" }), NOW)), ["s4"]);
});

test("busca e filtros funcionam em conjunto", () => {
  assert.deepEqual(ids(applySessionFilters(all, filters({ query: "remada", status: "ARCHIVED" }), NOW)), ["s4"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ query: "remada", period: "UPCOMING" }), NOW)), ["s3"]);
  assert.deepEqual(applySessionFilters(all, filters({ query: "remada", experienceId: paranoa.experienceId }), NOW), []);
});

test("ordena por mais próximas, mais recentes e mais antigas", () => {
  assert.deepEqual(ids(applySessionFilters(all, filters({ status: "ALL", sort: "UPCOMING" }), NOW)), ["s5", "s1", "s3", "s2", "s4"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ status: "ALL", sort: "RECENT" }), NOW)), ["s3", "s1", "s5", "s2", "s4"]);
  assert.deepEqual(ids(applySessionFilters(all, filters({ status: "ALL", sort: "OLDEST" }), NOW)), ["s4", "s2", "s5", "s1", "s3"]);
});

test("lê os filtros da URL e preserva os links antigos de arquivamento", () => {
  assert.deepEqual(sessionFiltersFrom({}), DEFAULT_SESSION_FILTERS);
  assert.equal(sessionFiltersFrom({ filtro: "arquivadas" }).status, "ARCHIVED");
  assert.equal(sessionFiltersFrom({ filtro: "todas" }).status, "ALL");
  assert.equal(sessionFiltersFrom({ filtro: "inexistente" }).status, "ACTIVE");
  const parsed = sessionFiltersFrom({ busca: " sunset ", filtro: "abertas", experiencia: "exp-1", periodo: "hoje", de: "2026-08-01", ate: "invalida", ordem: "antigas" });
  assert.deepEqual(parsed, { query: "sunset", status: "OPEN", experienceId: "exp-1", period: "TODAY", from: "2026-08-01", to: "", sort: "OLDEST" });
});

test("mantém a seleção na URL e sinaliza quando há filtros aplicados", () => {
  assert.equal(hasSessionFilters(DEFAULT_SESSION_FILTERS), false);
  assert.equal(sessionSearchParams(DEFAULT_SESSION_FILTERS), "");
  const applied = filters({ query: "sunset", status: "ARCHIVED", period: "PAST", sort: "OLDEST" });
  assert.equal(hasSessionFilters(applied), true);
  assert.deepEqual(sessionFiltersFrom(Object.fromEntries(new URLSearchParams(sessionSearchParams(applied)))), applied);
});
