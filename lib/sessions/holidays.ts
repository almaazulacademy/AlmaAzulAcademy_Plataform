/**
 * Feriados que valem em Brasília, para a apresentação das turmas.
 *
 * O site não decide preço nem duração por aqui: isso é sempre a configuração
 * gravada na própria sessão. Este calendário só serve para *explicar* uma
 * turma — por exemplo, uma sexta-feira de feriado com a experiência
 * tradicional de 1h30 — e para não contar um feriado como "dia de semana" ao
 * resumir as modalidades de uma experiência.
 *
 * Entram os feriados nacionais (Lei 662/1949 e alterações, inclusive a Lei
 * 14.759/2023 da Consciência Negra), a Sexta-feira Santa e os feriados
 * distritais do DF (Fundação de Brasília coincide com Tiradentes; Dia do
 * Evangélico, Lei Distrital 963/1995). Carnaval e Corpus Christi são pontos
 * facultativos, não feriados, e ficam de fora.
 *
 * Funções puras: entram datas no formato `AAAA-MM-DD` (dia local de Brasília),
 * sai o nome do feriado ou null.
 */

const FIXED_HOLIDAYS: Record<string, string> = {
  "01-01": "Confraternização Universal",
  "04-21": "Tiradentes e Aniversário de Brasília",
  "05-01": "Dia do Trabalho",
  "09-07": "Independência do Brasil",
  "10-12": "Nossa Senhora Aparecida",
  "11-02": "Finados",
  "11-15": "Proclamação da República",
  "11-20": "Dia Nacional de Zumbi e da Consciência Negra",
  "11-30": "Dia do Evangélico",
  "12-25": "Natal",
};

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano). */
export function easterSunday(year: number) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function goodFriday(year: number) {
  const easter = easterSunday(year);
  const date = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Nome do feriado em Brasília naquele dia local (`AAAA-MM-DD`), ou null. */
export function brasiliaHolidayName(dayKey: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const monthDay = `${match[2]}-${match[3]}`;
  if (FIXED_HOLIDAYS[monthDay]) return FIXED_HOLIDAYS[monthDay];
  if (monthDay === goodFriday(Number(match[1]))) return "Sexta-feira Santa";
  return null;
}
