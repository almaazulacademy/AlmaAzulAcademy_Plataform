/**
 * Como uma sessão vira a "turma" que o cliente vê e escolhe.
 *
 * Este módulo é a **única** tradução de uma linha de `public.sessions` para o
 * que aparece na tela: o horário exibido, a data exibida e o destino do clique.
 * Tudo sai de `sessions.id` e `sessions.starts_at` — nenhum horário é digitado
 * em componente, em texto editorial ou em constante.
 *
 * A regra existe por um motivo concreto: a Imersão Paranoá tem três turmas no
 * mesmo dia (09:00, 12:00 e 15:00). Se um componente montasse o rótulo por
 * conta própria, ou associasse o botão pela posição da lista, um cliente
 * poderia ver um horário e reservar outro. Com o vínculo feito aqui, o
 * `sessionId` e o horário nascem juntos, do mesmo registro, e continuam juntos
 * até o resumo, o pagamento e a confirmação.
 *
 * Funções puras de propósito: entram dados, saem rótulos. Sem rede, sem banco,
 * sem `Date.now()` — é o que permite testar os três horários sem subir nada.
 */

import {
  formatSessionDate,
  formatSessionDayMonth,
  formatSessionTime,
  formatSessionWeekday,
  toSessionDateTimeLocal,
} from "./date-time.ts";

/** O mínimo que identifica uma turma: quem ela é e quando começa. */
export type ChoosableSession = { id: string; startsAt: string };

/** Como um `starts_at` é escrito na tela. Nada aqui depende do id da sessão. */
export type SessionTimeLabels = {
  /** ISO original, preservado para reformatar sem reconverter fuso. */
  startsAt: string;
  /** `12:00` — o horário real da sessão, no fuso de Brasília. */
  time: string;
  /** `sábado` */
  weekday: string;
  /** `05 de setembro` */
  dayMonth: string;
  /** `sábado, 05 de setembro de 2026` */
  fullDate: string;
  /** `2026-09-05`, no fuso da sessão. Chave de agrupamento por dia. */
  dayKey: string;
  /** Rótulo acessível completo: quem lê por leitor de tela ouve o horário. */
  ariaLabel: string;
};

/** Uma turma pronta para a escolha, derivada do par id + starts_at. */
export type SessionChoice = SessionTimeLabels & {
  /** `sessions.id`. É ele que segue para `/reservar/[sessionId]` e para a reserva. */
  sessionId: string;
  /** Destino da escolha. Sempre o id desta sessão, nunca a posição na lista. */
  href: string;
};

/**
 * Turmas de um mesmo dia, na ordem do relógio.
 *
 * Cada turma carrega junto a sessão de origem, para que a tela leia preço,
 * vagas e horário do mesmo objeto — sem procurar a sessão de novo por id nem,
 * pior, por posição.
 */
export type SessionDayGroup<T extends ChoosableSession = ChoosableSession> = {
  dayKey: string;
  weekday: string;
  dayMonth: string;
  fullDate: string;
  turmas: Array<{ choice: SessionChoice; session: T }>;
};

function byStartsAt(a: { startsAt: string }, b: { startsAt: string }) {
  return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
}

/**
 * Escreve o horário de uma sessão do jeito que o cliente lê.
 *
 * Usada onde só existe o `starts_at` da reserva — o retorno do pagamento, por
 * exemplo, que confirma um pedido e não uma escolha ainda a fazer.
 */
export function describeSessionTime(startsAt: string): SessionTimeLabels {
  const time = formatSessionTime(startsAt);
  const fullDate = formatSessionDate(startsAt);

  return {
    startsAt,
    time,
    weekday: formatSessionWeekday(startsAt),
    dayMonth: formatSessionDayMonth(startsAt),
    fullDate,
    dayKey: toSessionDateTimeLocal(startsAt).slice(0, 10),
    ariaLabel: `Turma das ${time} — ${fullDate}`,
  };
}

/**
 * Traduz uma sessão para a turma exibida.
 *
 * O horário vem de `starts_at` e o destino vem de `id`, da mesma linha e na
 * mesma chamada. Não existe caminho em que um venha de uma sessão e o outro de
 * outra.
 */
export function buildSessionChoice(session: ChoosableSession): SessionChoice {
  return {
    ...describeSessionTime(session.startsAt),
    sessionId: session.id,
    href: `/reservar/${session.id}`,
  };
}

/**
 * Horários distintos das turmas abertas, em ordem cronológica.
 *
 * Alimenta o destaque "Turmas disponíveis" na página da experiência. Uma
 * experiência com três turmas por dia mostra `09:00 · 12:00 · 15:00`; uma com
 * turma única mostra só o horário dela. Nada aqui presume três turmas nem
 * presume 09:00.
 */
export function listSessionStartTimes(sessions: readonly ChoosableSession[]): string[] {
  const times = new Set(sessions.map((session) => formatSessionTime(session.startsAt)));
  return [...times].sort((a, b) => a.localeCompare(b));
}

/**
 * Agrupa as turmas por dia local.
 *
 * É o que deixa visível, de bater o olho, que o mesmo sábado tem 09:00, 12:00 e
 * 15:00 — em vez de três cartões quase idênticos soltos na grade. O dia é
 * calculado no fuso da sessão, então uma sessão de 23:30 não escorrega para o
 * dia seguinte por causa do UTC.
 */
export function groupSessionsByDay<T extends ChoosableSession>(sessions: readonly T[]): SessionDayGroup<T>[] {
  const groups = new Map<string, SessionDayGroup<T>>();

  for (const session of [...sessions].sort(byStartsAt)) {
    const choice = buildSessionChoice(session);
    const group = groups.get(choice.dayKey);
    if (group) {
      group.turmas.push({ choice, session });
      continue;
    }
    groups.set(choice.dayKey, {
      dayKey: choice.dayKey,
      weekday: choice.weekday,
      dayMonth: choice.dayMonth,
      fullDate: choice.fullDate,
      turmas: [{ choice, session }],
    });
  }

  return [...groups.values()];
}
