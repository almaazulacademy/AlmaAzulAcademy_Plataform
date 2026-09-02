/**
 * Filtro de data da agenda pública.
 *
 * A agenda geral e a grade de cada experiência mostram tudo o que está aberto:
 * em um fim de semana cheio isso vira uma lista longa para rolar. Este módulo é
 * a regra — e apenas a regra — do recorte por dia: validar o que veio da URL,
 * descobrir o dia local de uma sessão e separar as sessões daquele dia.
 *
 * Nada aqui consulta o banco. O filtro trabalha sobre as sessões que a página
 * **já** carregou pelas mesmas RPCs de sempre (`list_open_sessions`), então ele
 * nunca inventa horário, nunca revela sessão fechada e nunca muda o conceito de
 * disponibilidade — só decide o que continua na tela.
 *
 * O dia é sempre o dia **local em America/Sao_Paulo**. Uma remada de 05:30 em
 * Brasília é gravada como 08:30Z; comparada em UTC ela continuaria no mesmo dia,
 * mas uma sessão de 22:00 (01:00Z do dia seguinte) escorregaria para o dia
 * errado. Por isso a chave sai de `toSessionDateTimeLocal`, a mesma conversão
 * que já escreve as datas dos cartões.
 */

import { formatSessionDate, toSessionDateTimeLocal } from "./date-time.ts";

/** Nome do parâmetro na URL: `/agenda?date=2026-10-17`. */
export const DATE_FILTER_PARAM = "date";

/** O mínimo que uma sessão precisa ter para ser filtrada por dia. */
export type DatedSession = { startsAt: string | Date };

type SearchParamValue = string | string[] | undefined;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Meio-dia de Brasília no dia informado.
 *
 * O horário do meio existe para tirar do caminho qualquer ambiguidade de
 * horário de verão ou de arredondamento: nenhuma transição de fuso acontece ao
 * meio-dia, então o `Date` resultante sempre cai no dia pedido.
 */
function noonAt(dayKey: string) {
  return new Date(`${dayKey}T12:00:00-03:00`);
}

/**
 * `2026-10-17` — o dia local da sessão, em America/Sao_Paulo.
 *
 * É a chave que o filtro compara. Uma data impossível de interpretar devolve
 * string vazia em vez de estourar: a agenda de um cliente não pode quebrar por
 * causa de uma linha estranha.
 */
export function sessionDayKey(startsAt: string | Date): string {
  try {
    return toSessionDateTimeLocal(startsAt).slice(0, 10);
  } catch {
    return "";
  }
}

/**
 * Um `YYYY-MM-DD` que existe de verdade no calendário.
 *
 * O formato sozinho não basta: `2026-02-30` passa no regex e não existe. O
 * `Date` do ISO estrito rejeita esses casos, e a volta pela chave local confirma
 * que o dia continua sendo o mesmo.
 */
export function isValidDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY_PATTERN.test(value)) return false;
  const parsed = noonAt(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return sessionDayKey(parsed) === value;
}

/**
 * Lê o filtro da URL.
 *
 * Qualquer coisa fora do formato — vazio, `?date=amanhã`, `?date=2026-13-01`,
 * o parâmetro repetido — vira `null`, que é exatamente "sem filtro". A página
 * então mostra todas as datas, como se ninguém tivesse filtrado nada; um link
 * torto nunca produz erro nem tela quebrada.
 */
export function parseDateFilter(value: SearchParamValue): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return isValidDayKey(trimmed) ? trimmed : null;
}

/** As sessões daquele dia local. Sem data, a lista volta inteira e na ordem original. */
export function filterSessionsByDate<T extends DatedSession>(
  sessions: readonly T[],
  date: string | null,
): T[] {
  if (!date) return [...sessions];
  return sessions.filter((session) => sessionDayKey(session.startsAt) === date);
}

/** Dias que têm ao menos uma sessão aberta, em ordem crescente e sem repetição. */
export function listAvailableDayKeys(sessions: readonly DatedSession[]): string[] {
  const days = new Set<string>();
  for (const session of sessions) {
    const key = sessionDayKey(session.startsAt);
    if (key) days.add(key);
  }
  return [...days].sort();
}

/** `sábado, 17 de outubro de 2026` — como o cliente lê a data escolhida. */
export function formatDayKeyLabel(dayKey: string): string {
  return isValidDayKey(dayKey) ? formatSessionDate(noonAt(dayKey)) : "";
}
