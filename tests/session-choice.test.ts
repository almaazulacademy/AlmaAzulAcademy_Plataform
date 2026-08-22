/**
 * Regressão das três turmas da Imersão Paranoá.
 *
 * A auditoria do fluxo não encontrou troca de sessão: `sessions.id` e
 * `sessions.starts_at` já andavam juntos do cartão até a confirmação. Estes
 * testes existem para que continue assim — e para que ninguém volte a montar um
 * horário à mão, associar um botão pela posição da lista ou tratar 09:00 como o
 * horário padrão da experiência.
 *
 * As sessões daqui são as reais de um sábado de setembro/2026: 09:00, 12:00 e
 * 15:00 em Brasília, gravadas em UTC como o banco grava.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSessionChoice,
  describeSessionTime,
  groupSessionsByDay,
  listSessionStartTimes,
} from "../lib/sessions/choice.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Sábado, 05 de setembro de 2026. UTC = local + 3h em America/Sao_Paulo. */
const TURMA_09 = { id: "11111111-1111-4111-8111-111111111111", startsAt: "2026-09-05T12:00:00.000Z" };
const TURMA_12 = { id: "22222222-2222-4222-8222-222222222222", startsAt: "2026-09-05T15:00:00.000Z" };
const TURMA_15 = { id: "33333333-3333-4333-8333-333333333333", startsAt: "2026-09-05T18:00:00.000Z" };

/** Ordem devolvida pelo `list_open_sessions` (order by starts_at). */
const SABADO = [TURMA_09, TURMA_12, TURMA_15];

test("a sessão das 09:00 exibe 09:00 e leva ao próprio session_id", () => {
  const choice = buildSessionChoice(TURMA_09);

  assert.equal(choice.time, "09:00");
  assert.equal(choice.sessionId, TURMA_09.id);
  assert.equal(choice.href, `/reservar/${TURMA_09.id}`);
  assert.match(choice.ariaLabel, /09:00/);
  assert.match(choice.fullDate, /05 de setembro de 2026/);
});

test("a sessão das 12:00 exibe 12:00 e leva ao próprio session_id", () => {
  const choice = buildSessionChoice(TURMA_12);

  assert.equal(choice.time, "12:00");
  assert.equal(choice.sessionId, TURMA_12.id);
  assert.equal(choice.href, `/reservar/${TURMA_12.id}`);
  assert.match(choice.ariaLabel, /12:00/);
});

test("a sessão das 15:00 exibe 15:00 e leva ao próprio session_id", () => {
  const choice = buildSessionChoice(TURMA_15);

  assert.equal(choice.time, "15:00");
  assert.equal(choice.sessionId, TURMA_15.id);
  assert.equal(choice.href, `/reservar/${TURMA_15.id}`);
  assert.match(choice.ariaLabel, /15:00/);
});

test("cada turma do mesmo dia tem horário e destino próprios", () => {
  const choices = SABADO.map(buildSessionChoice);

  assert.deepEqual(choices.map((choice) => choice.time), ["09:00", "12:00", "15:00"]);
  assert.equal(new Set(choices.map((choice) => choice.sessionId)).size, 3);
  assert.equal(new Set(choices.map((choice) => choice.href)).size, 3);

  // Nenhum horário vem da posição na lista: embaralhar a ordem não muda o par
  // horário/session_id de nenhuma turma.
  const shuffled = [TURMA_15, TURMA_09, TURMA_12].map(buildSessionChoice);
  for (const choice of shuffled) {
    const original = choices.find((item) => item.sessionId === choice.sessionId);
    assert.equal(choice.time, original?.time);
    assert.equal(choice.href, original?.href);
  }
});

test("escolher a turma das 12:00 leva 12:00 para o resumo da reserva", () => {
  // O resumo lê a sessão que a página carregou pelo id da URL. Aqui a sessão é
  // a das 12:00, então tudo que o resumo mostra tem que ser da sessão das 12:00.
  const selecionada = buildSessionChoice(TURMA_12);
  const resumo = describeSessionTime(TURMA_12.startsAt);

  assert.equal(selecionada.href, `/reservar/${TURMA_12.id}`);
  assert.equal(resumo.time, "12:00");
  assert.equal(resumo.fullDate, selecionada.fullDate);
  assert.notEqual(resumo.time, describeSessionTime(TURMA_09.startsAt).time);
});

test("escolher a turma das 15:00 leva 15:00 para o resumo da reserva", () => {
  const selecionada = buildSessionChoice(TURMA_15);
  const resumo = describeSessionTime(TURMA_15.startsAt);

  assert.equal(selecionada.href, `/reservar/${TURMA_15.id}`);
  assert.equal(resumo.time, "15:00");
  assert.notEqual(resumo.time, describeSessionTime(TURMA_09.startsAt).time);
});

test("trocar de turma atualiza o resumo inteiro", () => {
  const passos = [TURMA_09, TURMA_15, TURMA_12, TURMA_09];
  const vistos = passos.map((session) => {
    const choice = buildSessionChoice(session);
    return { time: choice.time, sessionId: choice.sessionId, href: choice.href };
  });

  assert.deepEqual(vistos.map((item) => item.time), ["09:00", "15:00", "12:00", "09:00"]);
  assert.deepEqual(vistos.map((item) => item.sessionId), [TURMA_09.id, TURMA_15.id, TURMA_12.id, TURMA_09.id]);
  assert.equal(vistos[3].href, vistos[0].href);
  assert.notEqual(vistos[1].href, vistos[2].href);
});

test("o destaque da página lista as três turmas, sem repetir e sem inventar", () => {
  const duasSemanas = [
    ...SABADO,
    { id: "44444444-4444-4444-8444-444444444444", startsAt: "2026-09-06T12:00:00.000Z" },
    { id: "55555555-5555-4555-8555-555555555555", startsAt: "2026-09-06T15:00:00.000Z" },
    { id: "66666666-6666-4666-8666-666666666666", startsAt: "2026-09-06T18:00:00.000Z" },
  ];

  assert.deepEqual(listSessionStartTimes(duasSemanas), ["09:00", "12:00", "15:00"]);
  assert.deepEqual(listSessionStartTimes([TURMA_15, TURMA_09]), ["09:00", "15:00"]);
  assert.deepEqual(listSessionStartTimes([]), []);
});

test("as turmas do mesmo dia ficam agrupadas no dia certo", () => {
  const grupos = groupSessionsByDay(SABADO);

  assert.equal(grupos.length, 1);
  assert.equal(grupos[0].dayKey, "2026-09-05");
  assert.equal(grupos[0].weekday, "sábado");
  assert.deepEqual(grupos[0].turmas.map((turma) => turma.choice.time), ["09:00", "12:00", "15:00"]);
  // A sessão original viaja junto da turma: preço e vagas saem do mesmo objeto
  // que produziu o horário.
  assert.deepEqual(grupos[0].turmas.map((turma) => turma.session.id), SABADO.map((session) => session.id));
});

test("o agrupamento usa o dia de Brasília, não o dia UTC", () => {
  // 06/09 00:30 UTC é 05/09 21:30 em Brasília: a sessão pertence ao sábado.
  const noite = { id: "77777777-7777-4777-8777-777777777777", startsAt: "2026-09-06T00:30:00.000Z" };
  const grupos = groupSessionsByDay([TURMA_09, noite]);

  assert.equal(grupos.length, 1);
  assert.equal(grupos[0].dayKey, "2026-09-05");
  assert.deepEqual(grupos[0].turmas.map((turma) => turma.choice.time), ["09:00", "21:30"]);
});

test("sessões fora de ordem são exibidas na ordem do relógio", () => {
  const grupos = groupSessionsByDay([TURMA_15, TURMA_09, TURMA_12]);
  assert.deepEqual(grupos[0].turmas.map((turma) => turma.choice.time), ["09:00", "12:00", "15:00"]);
});

test("outras experiências continuam funcionando", () => {
  // Remada Sunset: turma única. Nascer do Sol: 05:30 na sexta, 06:00 no sábado.
  const sunset = [
    { id: "88888888-8888-4888-8888-888888888888", startsAt: "2026-09-06T20:00:00.000Z" },
    { id: "99999999-9999-4999-8999-999999999999", startsAt: "2026-09-13T20:00:00.000Z" },
  ];
  const nascerDoSol = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", startsAt: "2026-09-04T08:30:00.000Z" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", startsAt: "2026-09-05T09:00:00.000Z" },
  ];

  assert.deepEqual(listSessionStartTimes(sunset), ["17:00"]);
  assert.deepEqual(listSessionStartTimes(nascerDoSol), ["05:30", "06:00"]);

  const gruposSunset = groupSessionsByDay(sunset);
  assert.equal(gruposSunset.length, 2);
  assert.deepEqual(gruposSunset.map((grupo) => grupo.turmas.length), [1, 1]);
  assert.equal(gruposSunset[0].turmas[0].choice.href, `/reservar/${sunset[0].id}`);

  const gruposNascer = groupSessionsByDay(nascerDoSol);
  assert.deepEqual(gruposNascer.map((grupo) => grupo.turmas[0].choice.time), ["05:30", "06:00"]);
});

/**
 * Arquivos onde o horário exibido **precisa** vir da sessão. Um literal de
 * relógio em qualquer um deles é exatamente o defeito que a auditoria procurou.
 */
const FLOW_FILES = [
  "components/session-times.tsx",
  "components/sessions-section.tsx",
  "components/agenda-sessions.tsx",
  "components/reservation/session-turma.tsx",
  "components/reservation/reservation-summary.tsx",
  "components/reservation/reservation-hold.tsx",
  "app/reservar/[sessionId]/page.tsx",
  "app/pagamento/retorno/page.tsx",
  "lib/sessions/choice.ts",
];

test("nenhum horário fixo no fluxo de escolha, resumo e confirmação", () => {
  const clock = /\b([01]?\d|2[0-3]):[0-5]\d\b/;
  const informalHour = /\b\d{1,2}\s?h\b/i;

  for (const file of FLOW_FILES) {
    // Comentários explicam o problema citando 09:00; o que não pode é o código
    // renderizar um horário que não veio da sessão.
    const code = source(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/[^\n]*$/gm, "")
      .replace(/^\s*\*[^\n]*$/gm, "");

    assert.doesNotMatch(code, clock, `${file} não pode conter horário fixo`);
    assert.doesNotMatch(code, informalHour, `${file} não pode conter horário fixo`);
  }
});

test("o conteúdo editorial da Imersão Paranoá não fixa nenhum horário", () => {
  const editorial = source("lib/editorial/imersao-paranoa.ts");

  assert.doesNotMatch(editorial, /\b([01]?\d|2[0-3]):[0-5]\d\b/);
  assert.doesNotMatch(editorial, /\b\d{1,2}\s?h\b/i);
  assert.doesNotMatch(editorial, /9h|09h|às 9/i);
});

test("as telas do fluxo leem o horário da sessão, não de um texto próprio", () => {
  assert.match(source("components/sessions-section.tsx"), /groupSessionsByDay\(sessions\)/);
  assert.match(source("components/sessions-section.tsx"), /\{choice\.time\}/);
  assert.match(source("components/session-times.tsx"), /listSessionStartTimes\(result\.sessions\)/);
  assert.match(source("components/reservation/session-turma.tsx"), /describeSessionTime\(startsAt\)/);
  assert.match(source("components/reservation/reservation-summary.tsx"), /buildSessionChoice\(session\)/);
  assert.match(source("components/agenda-sessions.tsx"), /buildSessionChoice\(session\)/);

  // O destino da escolha é sempre o id da sessão exibida.
  assert.match(source("lib/sessions/choice.ts"), /href: `\/reservar\/\$\{session\.id\}`/);
  assert.match(source("app/reservar/[sessionId]/page.tsx"), /startsAt=\{session\.startsAt\}/);
  assert.match(source("app/pagamento/retorno/page.tsx"), /startsAt=\{summary\.startsAt\}/);
});

test("a auditoria de horários no banco é somente leitura e não projeta PII", () => {
  const sql = source("supabase/diagnostics/imersao_paranoa_session_times_audit.sql");

  assert.doesNotMatch(sql, /^\s*(insert|update|delete|create|alter|drop|truncate|call|grant|revoke)\b/im);
  assert.doesNotMatch(sql, /\b(full_name|phone|email|cpf_hash|cpf_last4|notes|checkout_url|provider_reference|payload)\b/i);

  // A conversão de fuso acontece no banco, com o mesmo fuso do produto.
  assert.match(sql, /at time zone 'America\/Sao_Paulo'/);
  assert.match(sql, /experience\.slug = 'imersao-paranoa'/);
});

test("o horário aparece em destaque em cada etapa do fluxo", () => {
  // Regressão de comunicação: antes desta mudança o horário sumia da tela entre
  // o envio do formulário e o e-mail de confirmação.
  assert.match(source("app/reservar/[sessionId]/page.tsx"), /<SessionTurma/);
  assert.match(source("components/reservation/reservation-hold.tsx"), /<SessionTurma/);
  assert.match(source("app/pagamento/retorno/page.tsx"), /<SessionTurma/);
  assert.match(source("components/reservation/reservation-lookup.tsx"), /session=\{reservation\.session\}/);
  assert.match(source("components/experience-landing.tsx"), /<SessionTimes experienceSlug=\{experience\.slug\}/);
});
