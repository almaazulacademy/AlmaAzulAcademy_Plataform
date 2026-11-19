/**
 * Formatos das remadas regulares (dezembro/2026): 1 hora durante a semana,
 * 1h30 no fim de semana e em feriados.
 *
 * O site nunca deduz preço nem duração do dia da semana: lê os dois da sessão.
 * Estes testes cobrem a apresentação — o rótulo da duração, os feriados de
 * Brasília, o resumo por formato, o texto das páginas do Lago Norte e a frase
 * de duração do e-mail — com sessões no formato em que o banco as grava (UTC).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateExperienceEditorial } from "../lib/editorial/experience.ts";
import { imersaoParanoaFallback } from "../lib/editorial/imersao-paranoa.ts";
import { applyModalityCopy } from "../lib/editorial/modality-copy.ts";
import { CAPSULA_BAR_CAPACITY, experienceModalities, LAGO_NORTE_CAPACITY } from "../lib/editorial/modalities.ts";
import { refinePublicExperience } from "../lib/editorial/refine.ts";
import { DURATION_NOTE, durationNoteFor } from "../lib/reservations/confirmation-email.ts";
import { brasiliaHolidayName, easterSunday } from "../lib/sessions/holidays.ts";
import {
  describeWeekdays,
  formatDurationLabel,
  formatExperienceDuration,
  hasSeveralTimesOnSameDay,
  sessionHolidayName,
  summarizeModalities,
} from "../lib/sessions/modality.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function migrationEditorial(file: string) {
  const match = source(`supabase/migrations/${file}`).match(/\$editorial\$\s*(\{[\s\S]*?\})\s*\$editorial\$::jsonb/)!;
  return JSON.parse(match[1]);
}

/** Horário local de Brasília (UTC−3) para o ISO que o banco grava. */
function at(local: string) {
  return new Date(`${local}:00-03:00`).toISOString();
}

const session = (local: string, durationMinutes: number, priceCents: number) => ({ startsAt: at(local), durationMinutes, priceCents });

test("a duração é escrita como o cliente lê", () => {
  assert.equal(formatDurationLabel(60), "1 hora");
  assert.equal(formatDurationLabel(90), "1h30");
  assert.equal(formatDurationLabel(120), "2 horas");
  assert.equal(formatDurationLabel(75), "1h15");
  assert.equal(formatDurationLabel(45), "45 minutos");
  assert.equal(formatDurationLabel(0), "");
  assert.equal(formatExperienceDuration(60), "1 hora de experiência");
  assert.equal(formatExperienceDuration(90), "1h30 de experiência");
});

test("feriados de Brasília: nacionais, distritais e Sexta-feira Santa", () => {
  assert.deepEqual(easterSunday(2026), { month: 4, day: 5 });
  assert.deepEqual(easterSunday(2027), { month: 3, day: 28 });
  assert.equal(brasiliaHolidayName("2026-12-25"), "Natal");
  assert.equal(brasiliaHolidayName("2026-11-20"), "Dia Nacional de Zumbi e da Consciência Negra");
  assert.equal(brasiliaHolidayName("2026-11-30"), "Dia do Evangélico");
  assert.equal(brasiliaHolidayName("2026-04-21"), "Tiradentes e Aniversário de Brasília");
  assert.equal(brasiliaHolidayName("2026-04-03"), "Sexta-feira Santa");
  assert.equal(brasiliaHolidayName("2027-03-26"), "Sexta-feira Santa");
  // Véspera de Natal e de Ano-Novo não são feriado; Carnaval e Corpus Christi são ponto facultativo.
  for (const day of ["2026-12-24", "2026-12-31", "2026-02-17", "2026-06-04", "2026-12-01"]) assert.equal(brasiliaHolidayName(day), null, day);
  // O dia é o local de Brasília, não o de UTC: 25/12 às 22h em Brasília já é 26/12 em UTC.
  assert.equal(sessionHolidayName(at("2026-12-25T22:00")), "Natal");
  assert.equal(sessionHolidayName(at("2026-12-24T22:00")), null);
});

test("os dias de cada formato são descritos sem ambiguidade", () => {
  assert.equal(describeWeekdays([1, 3, 5]), "segundas, quartas e sextas");
  assert.equal(describeWeekdays([5, 4, 3, 2, 1]), "segunda a sexta");
  assert.equal(describeWeekdays([6, 7]), "sábados e domingos");
  assert.equal(describeWeekdays([7]), "domingos");
  assert.equal(describeWeekdays([6]), "sábados");
  assert.equal(describeWeekdays([1, 2, 3, 4, 5, 6, 7]), "todos os dias");
  assert.equal(describeWeekdays([]), "");
});

test("Sunset do Cápsula Bar: dia útil 17:30/60/R$ 60 e fim de semana 17:00/90/R$ 70, com o Natal à parte", () => {
  const sessions = [
    session("2026-12-21T17:30", 60, 6000), // segunda
    session("2026-12-23T17:30", 60, 6000), // quarta
    session("2026-12-24T17:30", 60, 6000), // quinta, véspera: dia útil
    session("2026-12-25T17:30", 60, 6000), // sexta, Natal
    session("2026-12-26T17:00", 90, 7000), // sábado
    session("2026-12-27T17:00", 90, 7000), // domingo
  ];
  const [weekday, weekend] = summarizeModalities(sessions);
  assert.deepEqual(
    { ...weekday },
    { durationMinutes: 60, priceCents: 6000, times: ["17:30"], weekdays: [1, 3, 4], holidays: ["2026-12-25"], sessionCount: 4 },
  );
  assert.deepEqual(
    { ...weekend },
    { durationMinutes: 90, priceCents: 7000, times: ["17:00"], weekdays: [6, 7], holidays: [], sessionCount: 2 },
  );
});

test("Sunset do Lago Norte: segunda/quarta/sexta 17:30 de 1 hora e domingo 17:00 de 1h30", () => {
  const groups = summarizeModalities([
    session("2026-12-07T17:30", 60, 6000),
    session("2026-12-09T17:30", 60, 6000),
    session("2026-12-11T17:30", 60, 6000),
    session("2026-12-13T17:00", 90, 7000),
  ]);
  assert.deepEqual(groups.map((group) => [formatDurationLabel(group.durationMinutes), group.priceCents, describeWeekdays(group.weekdays), group.times]), [
    ["1 hora", 6000, "segundas, quartas e sextas", ["17:30"]],
    ["1h30", 7000, "domingos", ["17:00"]],
  ]);
});

test("Nascer do Sol: 05:30 de 1 hora durante a semana e 05:00 de 1h30 aos sábados não são 'turmas no mesmo dia'", () => {
  const sessions = [
    session("2026-12-07T05:30", 60, 6000),
    session("2026-12-09T05:30", 60, 6000),
    session("2026-12-12T05:00", 90, 7000),
    session("2026-11-28T05:30", 90, 7000), // sábado de novembro, ainda no horário antigo
  ];
  assert.equal(hasSeveralTimesOnSameDay(sessions), false);
  const [weekday, saturday] = summarizeModalities(sessions);
  assert.deepEqual([weekday.times, describeWeekdays(weekday.weekdays)], [["05:30"], "segundas e quartas"]);
  assert.deepEqual([saturday.times, describeWeekdays(saturday.weekdays)], [["05:00", "05:30"], "sábados"]);
});

test("Imersão Paranoá continua com três turmas no mesmo dia", () => {
  assert.equal(hasSeveralTimesOnSameDay([
    session("2026-12-05T09:00", 90, 7000),
    session("2026-12-05T12:00", 90, 7000),
    session("2026-12-05T15:00", 90, 7000),
  ]), true);
});

test("feriado em dia útil com a experiência tradicional fica no formato de 1h30, não vira 'sextas'", () => {
  // 20/11/2026 é sexta-feira e feriado da Consciência Negra.
  const [group] = summarizeModalities([session("2026-11-20T09:00", 90, 7000), session("2026-11-21T09:00", 90, 7000)]);
  assert.deepEqual([group.weekdays, group.holidays], [[6], ["2026-11-20"]]);
});

test("sessão com preço ou duração especial forma um grupo próprio e mostra a duração real", () => {
  const groups = summarizeModalities([session("2026-12-19T16:00", 75, 8500), session("2026-12-19T09:00", 90, 7000)]);
  assert.deepEqual(groups.map((group) => [group.durationMinutes, group.priceCents]), [[75, 8500], [90, 7000]]);
  assert.equal(formatExperienceDuration(75), "1h15 de experiência");
});

test("formatos aprovados: 60 min/R$ 60 e 90 min/R$ 70; Lago Norte 24 vagas, Cápsula Bar 12", () => {
  assert.equal(LAGO_NORTE_CAPACITY, 24);
  assert.equal(CAPSULA_BAR_CAPACITY, 12);
  for (const [slug, capacity, weekdaySchedule, weekendSchedule] of [
    ["remada-sunset", 24, "Segundas, quartas e sextas, às 17h30", "Domingos, às 17h"],
    ["remada-nascer-do-sol", 24, "Segundas, quartas e sextas, às 5h30", "Sábados, às 5h"],
    ["remada-sunset-concha-acustica", 12, "Segunda a sexta, às 17h30", "Sábados e domingos, às 17h"],
  ] as const) {
    const config = experienceModalities(slug)!;
    assert.equal(config.capacity, capacity, slug);
    assert.deepEqual(config.items.map((item) => [item.durationMinutes, item.priceCents, item.schedule]), [
      [60, 6000, weekdaySchedule],
      [90, 7000, weekendSchedule],
    ], slug);
  }
  // Experiências sem turma de dia de semana não ganham o formato de 1 hora.
  assert.equal(experienceModalities("imersao-paranoa"), null);
  assert.equal(experienceModalities("rota-ermida-ponte-jk"), null);
});

test("Nascer do Sol: some o 6h, a chegada às 5h50 e as 28 pessoas", () => {
  const editorial = migrationEditorial("202608040001_remada_nascer_do_sol.sql");
  const revised = refinePublicExperience({ ...imersaoParanoaFallback, slug: "remada-nascer-do-sol", editorial });
  const text = JSON.stringify(revised.editorial);
  for (const stale of [/\b6h\b/, /5h50/, /28 pessoas/, /Capacidade padrão/, /sextas-feiras e sábados/, /Remada de 1h30/]) assert.doesNotMatch(text, stale);
  assert.equal(revised.editorial.hero.title, "Comece o dia onde tudo desperta.");
  assert.deepEqual(revised.editorial.hero.details, ["Duração: 1h ou 1h30", "Horário: 5h30 ou 5h", "Nível: iniciantes ao avançado"]);
  assert.deepEqual(revised.editorial.quickFacts.map((fact) => fact.label), ["Duração", "Horário de saída", "Chegada recomendada", "Local", "Nível"]);
  assert.match(revised.editorial.faq!.items.find((item) => item.question === "Que horas devo chegar?")!.answer, /10 minutos antes do horário da sua turma/);
  assert.equal(validateExperienceEditorial(revised.editorial, true).success, true);
  assert.deepEqual(refinePublicExperience(revised), revised, "aplicar de novo não muda nada");
});

test("Sunset do Lago Norte: título novo, sem 28 pessoas nem 'sextas-feiras e domingos'", () => {
  const editorial = migrationEditorial("202608030003_remada_sunset.sql");
  const revised = refinePublicExperience({ ...imersaoParanoaFallback, slug: "remada-sunset", editorial });
  const text = JSON.stringify(revised.editorial);
  for (const stale of [/28 pessoas/, /sextas-feiras e domingos/, /de 1h30 em/, /Experiência de 1h30/]) assert.doesNotMatch(text, stale);
  assert.equal(revised.editorial.hero.title, "O melhor pôr do sol de Brasília, no seu ritmo.");
  assert.equal(revised.editorial.quickFacts.find((fact) => fact.label === "Duração")?.value, "1h ou 1h30, conforme o dia");
  assert.equal(validateExperienceEditorial(revised.editorial, true).success, true);
});

test("texto já reescrito pela equipe no painel passa intacto", () => {
  const editorial = migrationEditorial("202608040001_remada_nascer_do_sol.sql");
  editorial.hero.subtitle = "Texto novo escrito pela equipe.";
  editorial.quickFacts[1].value = "5h15";
  const revised = applyModalityCopy({ ...imersaoParanoaFallback, slug: "remada-nascer-do-sol", editorial });
  assert.equal(revised.editorial.hero.subtitle, "Texto novo escrito pela equipe.");
  assert.equal(revised.editorial.quickFacts.find((fact) => fact.label === "Horário de saída")?.value, "5h15");
});

test("o Cápsula Bar mantém o texto aplicado na revisão de dezembro e as outras experiências não mudam", () => {
  const experience = structuredClone(imersaoParanoaFallback);
  assert.deepEqual(applyModalityCopy(experience), experience);
  assert.deepEqual(applyModalityCopy({ ...experience, slug: "remada-sunset-concha-acustica" }).editorial, experience.editorial);
});

test("e-mail do Lago Norte: 1h30 continua palavra por palavra; a turma de 1 hora diz 1 hora", () => {
  assert.equal(durationNoteFor(90), DURATION_NOTE);
  assert.equal(durationNoteFor(undefined), DURATION_NOTE);
  assert.equal(durationNoteFor(null), DURATION_NOTE);
  assert.equal(durationNoteFor(60), "A experiência dura em torno de 1 hora.");
});

test("telas: cartão da turma mostra a duração; quadro de turmas só fala em 'mesmo dia' quando é verdade", () => {
  const grid = source("components/sessions-section.tsx");
  assert.match(grid, /formatExperienceDuration\(session\.durationMinutes\)/);
  assert.match(grid, /brasiliaHolidayName\(day\.dayKey\)/);
  const board = source("components/session-times.tsx");
  assert.match(board, /sameDay=\{hasSeveralTimesOnSameDay\(result\.sessions\)\}/);
  assert.match(board, /O horário de início muda conforme a data/);
  const landing = source("components/experience-landing.tsx");
  assert.match(landing, /experienceModalities\(experience\.slug\)/);
  const modalities = source("components/experience-modalities.tsx");
  assert.match(modalities, /Novas datas deste formato serão abertas em breve/);
  assert.match(modalities, /Até \{modalities\.capacity\} participantes por turma/);
  // Agenda e resumo da reserva continuam lendo duração e preço da sessão.
  assert.match(source("components/agenda-sessions.tsx"), /formatExperienceDuration\(session\.durationMinutes\)/);
  assert.match(source("components/reservation/reservation-summary.tsx"), /formatExperienceDuration\(session\.durationMinutes\)/);
  assert.match(source("components/reservation/reservation-summary.tsx"), /formatPrice\(session\.priceCents \* quantity\)/);
});
