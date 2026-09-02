/**
 * Filtro de data da agenda pública.
 *
 * O filtro é a única peça nova entre o cliente e a lista de sessões, e ele não
 * pode nem esconder uma turma que existe nem revelar uma que não existe. Estes
 * testes travam três coisas: a comparação sempre no fuso de Brasília, a
 * validação do `?date=` vindo da URL e o fato de que a listagem filtrada
 * continua sendo um subconjunto exato do que a página já carregava.
 *
 * As sessões abaixo são as reais do calendário: 05:30 do Nascer do Sol (08:30Z,
 * o caso que mais facilmente escorregaria de dia em UTC) e as turmas de tarde e
 * noite do mesmo sábado.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { groupSessionsByDay } from "../lib/sessions/choice.ts";
import {
  DATE_FILTER_PARAM,
  filterSessionsByDate,
  formatDayKeyLabel,
  isValidDayKey,
  listAvailableDayKeys,
  parseDateFilter,
  sessionDayKey,
} from "../lib/sessions/date-filter.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Sábado, 17/10/2026 em Brasília. UTC = local + 3h. */
const NASCER_DO_SOL = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  experienceSlug: "remada-nascer-do-sol",
  startsAt: "2026-10-17T08:30:00.000Z", // 05:30 local
};
const IMERSAO_09 = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  experienceSlug: "imersao-paranoa",
  startsAt: "2026-10-17T12:00:00.000Z", // 09:00 local
};
const IMERSAO_15 = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  experienceSlug: "imersao-paranoa",
  startsAt: "2026-10-17T18:00:00.000Z", // 15:00 local
};
const SUNSET = {
  id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  experienceSlug: "remada-sunset",
  startsAt: "2026-10-17T22:00:00.000Z", // 19:00 local, ainda 17/10
};
/** Domingo seguinte — a turma de 22:00 local cai em 01:00Z do dia 19 em UTC. */
const IMERSAO_DOMINGO_TARDE = {
  id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
  experienceSlug: "imersao-paranoa",
  startsAt: "2026-10-18T15:00:00.000Z", // 12:00 local, 18/10
};
const LUA_CHEIA_DOMINGO = {
  id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
  experienceSlug: "remada-lua-cheia",
  startsAt: "2026-10-19T01:00:00.000Z", // 22:00 local do dia 18/10
};

const AGENDA = [NASCER_DO_SOL, IMERSAO_09, IMERSAO_15, SUNSET, IMERSAO_DOMINGO_TARDE, LUA_CHEIA_DOMINGO];

// --- Dia local em America/Sao_Paulo -----------------------------------------

test("a sessão das 05:30 pertence ao próprio dia, não ao anterior", () => {
  // 08:30Z é o mesmo dia em UTC e em Brasília; o teste existe para o caso
  // citado pela operação continuar coberto se a conversão mudar.
  assert.equal(sessionDayKey(NASCER_DO_SOL.startsAt), "2026-10-17");
});

test("a sessão de 22:00 local não escorrega para o dia seguinte", () => {
  // Em UTC ela é 19/10T01:00. Comparar sem fuso a jogaria no domingo errado.
  assert.equal(LUA_CHEIA_DOMINGO.startsAt.slice(0, 10), "2026-10-19");
  assert.equal(sessionDayKey(LUA_CHEIA_DOMINGO.startsAt), "2026-10-18");
});

test("uma data ilegível não derruba o cálculo do dia", () => {
  assert.equal(sessionDayKey("não é data"), "");
});

test("os dias disponíveis saem em ordem e sem repetição", () => {
  assert.deepEqual(listAvailableDayKeys(AGENDA), ["2026-10-17", "2026-10-18"]);
});

test("o rótulo da data escolhida usa o dia de Brasília", () => {
  assert.match(formatDayKeyLabel("2026-10-17"), /17 de outubro de 2026/);
  assert.match(formatDayKeyLabel("2026-10-17"), /sábado/);
  assert.equal(formatDayKeyLabel("2026-13-01"), "");
});

// --- Recorte da listagem -----------------------------------------------------

test("sem filtro, todas as sessões continuam na lista", () => {
  const visible = filterSessionsByDate(AGENDA, null);

  assert.equal(visible.length, AGENDA.length);
  assert.deepEqual(visible.map((session) => session.id), AGENDA.map((session) => session.id));
});

test("com data escolhida, só as sessões daquele dia aparecem", () => {
  const visible = filterSessionsByDate(AGENDA, "2026-10-17");

  assert.deepEqual(visible.map((session) => session.id), [
    NASCER_DO_SOL.id,
    IMERSAO_09.id,
    IMERSAO_15.id,
    SUNSET.id,
  ]);
});

test("na agenda geral o mesmo dia reúne experiências diferentes", () => {
  const slugs = filterSessionsByDate(AGENDA, "2026-10-17").map((session) => session.experienceSlug);

  assert.deepEqual([...new Set(slugs)], ["remada-nascer-do-sol", "imersao-paranoa", "remada-sunset"]);
});

test("uma data sem sessões devolve lista vazia — e nada é inventado", () => {
  assert.deepEqual(filterSessionsByDate(AGENDA, "2026-10-20"), []);
});

test("limpar o filtro devolve exatamente a lista original", () => {
  const filtered = filterSessionsByDate(AGENDA, "2026-10-18");
  assert.equal(filtered.length, 2);

  const cleared = filterSessionsByDate(AGENDA, null);
  assert.deepEqual(cleared.map((session) => session.id), AGENDA.map((session) => session.id));
});

test("o filtro nunca acrescenta sessão: o resultado é subconjunto da lista carregada", () => {
  const ids = new Set(AGENDA.map((session) => session.id));

  for (const day of [...listAvailableDayKeys(AGENDA), "2026-10-20", null]) {
    for (const session of filterSessionsByDate(AGENDA, day)) {
      assert.ok(ids.has(session.id), `sessão inesperada: ${session.id}`);
    }
  }
});

test("na página de uma experiência o filtro não alcança as outras", () => {
  // A página já lê só as sessões do próprio slug; o filtro trabalha por cima
  // dessa lista e não tem como ver a agenda das demais experiências.
  const daImersao = AGENDA.filter((session) => session.experienceSlug === "imersao-paranoa");
  const visible = filterSessionsByDate(daImersao, "2026-10-17");

  assert.deepEqual(visible.map((session) => session.id), [IMERSAO_09.id, IMERSAO_15.id]);
  assert.ok(visible.every((session) => session.experienceSlug === "imersao-paranoa"));
});

test("o filtro por dia e o agrupamento por dia enxergam o mesmo calendário", () => {
  // A grade da experiência filtra blocos de dia; se as duas chaves divergissem,
  // escolher uma data válida esvaziaria a tela sem motivo.
  const groups = groupSessionsByDay(AGENDA);

  assert.deepEqual(groups.map((group) => group.dayKey), listAvailableDayKeys(AGENDA));
  for (const group of groups) {
    assert.equal(group.turmas.length, filterSessionsByDate(AGENDA, group.dayKey).length);
  }
});

// --- Query param -------------------------------------------------------------

test("o parâmetro da URL é `date`", () => {
  assert.equal(DATE_FILTER_PARAM, "date");
});

test("uma data válida em YYYY-MM-DD é aceita", () => {
  assert.equal(parseDateFilter("2026-10-17"), "2026-10-17");
  assert.equal(parseDateFilter(" 2026-10-17 "), "2026-10-17");
  assert.ok(isValidDayKey("2026-02-28"));
});

test("um `?date=` inválido é ignorado com segurança, sem quebrar a página", () => {
  const invalid = [
    undefined,
    "",
    "   ",
    "amanhã",
    "17/10/2026",
    "2026-10-17T09:00:00Z",
    "2026-13-01",
    "2026-02-30",
    "2026-00-10",
    "20261017",
    "<script>alert(1)</script>",
    123 as unknown as string,
  ];

  for (const value of invalid) {
    assert.equal(parseDateFilter(value as never), null, `deveria ignorar: ${String(value)}`);
  }
});

test("o parâmetro repetido usa a primeira ocorrência válida e nunca estoura", () => {
  assert.equal(parseDateFilter(["2026-10-17", "2026-10-18"]), "2026-10-17");
  assert.equal(parseDateFilter(["lixo", "2026-10-18"]), null);
  assert.equal(parseDateFilter([]), null);
});

test("data ignorada equivale a não filtrar: a lista volta inteira", () => {
  const visible = filterSessionsByDate(AGENDA, parseDateFilter("2026-02-30"));

  assert.equal(visible.length, AGENDA.length);
});

// --- Contrato das telas ------------------------------------------------------

test("as duas listagens públicas usam o mesmo filtro", () => {
  for (const path of ["components/agenda-sessions.tsx", "components/sessions-section.tsx"]) {
    assert.match(source(path), /SessionDateFilter/, `${path} deveria usar o filtro compartilhado`);
  }
});

test("as páginas públicas leem `?date=` já validado", () => {
  for (const path of ["app/agenda/page.tsx", "app/experiencias/[slug]/page.tsx"]) {
    const file = source(path);
    assert.match(file, /parseDateFilter/, `${path} deveria validar o parâmetro`);
    assert.match(file, /DATE_FILTER_PARAM/, `${path} deveria usar o nome canônico do parâmetro`);
  }
});

test("o filtro oferece limpar e explica a data sem sessões", () => {
  const filter = source("components/session-date-filter.tsx");

  assert.match(filter, /Escolha uma data/);
  assert.match(filter, /Ver todas as datas/);
  assert.match(filter, /type="date"/);
});

test("o estado vazio da data escolhida é explicado em cada contexto", () => {
  assert.match(source("components/agenda-sessions.tsx"), /Não encontramos experiências disponíveis nesta data\./);
  assert.match(source("components/sessions-section.tsx"), /Não encontramos horários desta experiência nesta data\./);
});

test("o filtro revalida a data recebida em vez de confiar em quem o chama", () => {
  // Um `initialDate` torto viraria rótulo vazio na tela ("Nada acontece em .")
  // se o componente o aceitasse como veio.
  assert.match(source("components/session-date-filter.tsx"), /useState<string \| null>\(\(\) => parseDateFilter\(/);
});

test("o filtro não consulta o banco: ele recebe blocos já renderizados", () => {
  const filter = source("components/session-date-filter.tsx");

  assert.doesNotMatch(filter, /supabase|createClient|fetch\(/i);
  assert.match(filter, /^"use client";/);
});

test("o filtro é responsivo sem mudar de lógica entre desktop e mobile", () => {
  // Uma única listagem filtrada alimenta os dois tamanhos: o `sm:` só troca
  // empilhamento por linha, então não existe caminho de código exclusivo do
  // mobile que possa filtrar diferente.
  const filter = source("components/session-date-filter.tsx");

  assert.match(filter, /flex-col gap-4 sm:flex-row/);
  assert.equal(filter.match(/const visible =/g)?.length, 1);
});

test("nada no filtro toca capacidade, reserva ou pagamento", () => {
  const filter = source("components/session-date-filter.tsx");
  const lib = source("lib/sessions/date-filter.ts");

  for (const file of [filter, lib]) {
    assert.doesNotMatch(file, /remainingSpots|available_spots|checkout|reservation|payment/i);
  }
});
