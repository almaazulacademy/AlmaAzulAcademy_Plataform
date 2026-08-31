/**
 * Regras da troca de turma de uma reserva confirmada.
 *
 * Funções puras: entram dados, sai um veredito. Sem rede, sem banco, sem
 * `Date.now()` implícito — o instante é sempre um parâmetro, para os testes
 * poderem colocar uma sessão no passado sem esperar o relógio.
 *
 * ## Este módulo não é a autoridade
 *
 * Quem decide se a reserva muda de turma é `admin_change_reservation_session`,
 * dentro da transação, com as duas sessões travadas. O que existe aqui é a
 * mesma régua aplicada mais cedo, para a tela poder desabilitar uma opção
 * impossível e explicar o motivo em português antes de o admin clicar.
 *
 * A ordem das checagens é deliberadamente idêntica à do SQL: quando a RPC
 * recusa, a mensagem que o admin já tinha lido é a mesma que ele recebe.
 *
 * ## Reagendamento entre experiências
 *
 * O destino não precisa mais ser da mesma experiência da reserva: a agenda
 * inteira é elegível. O que sobrou de fronteira é a publicação — entrar em uma
 * experiência que não está PUBLISHED é recusado, porque seria mover um cliente
 * pagante para um produto que não está à venda. A experiência da própria
 * reserva é sempre aceita, o que mantém o fluxo antigo intacto.
 */

import type { ExperienceStatus, SessionLifecycleStatus } from "./types.ts";
import type { ReservationStatus } from "../reservations/types.ts";

/** Uma turma candidata, do jeito que o banco a descreve. */
export type SessionChangeOption = {
  sessionId: string;
  experienceId: string;
  experienceTitle: string;
  /** Publicação da experiência dona da turma. Só PUBLISHED recebe de fora. */
  experienceStatus: ExperienceStatus;
  startsAt: string;
  durationMinutes: number;
  capacity: number;
  remainingSpots: number;
  priceCents: number;
  status: SessionLifecycleStatus;
  /** Calculado pelo banco: as vagas restantes cobrem a reserva inteira. */
  fits: boolean;
};

/** A turma atual da reserva. Não tem `fits`: ela não é destino de si mesma. */
export type SessionChangeCurrent = Omit<SessionChangeOption, "fits">;

export type ReservationSessionOptions = {
  reservationId: string;
  publicCode: string;
  fullName: string;
  status: ReservationStatus;
  quantity: number;
  totalCents: number;
  /** Valor unitário efetivamente pago. Nunca é recalculado por uma troca. */
  unitPriceCents: number;
  /**
   * Quantas turmas futuras e abertas ficaram de fora por não terem vagas para o
   * grupo inteiro. Existe para a tela poder explicar a ausência delas em vez de
   * simplesmente não mostrá-las.
   */
  hiddenForCapacity: number;
  current: SessionChangeCurrent | null;
  options: SessionChangeOption[];
};

/** Cada recusa possível, com o mesmo símbolo que a RPC levanta. */
export type SessionChangeRejection =
  | "RESERVATION_NOT_CONFIRMED"
  | "SESSION_NOT_FOUND"
  | "SAME_SESSION"
  | "EXPERIENCE_NOT_AVAILABLE"
  | "SESSION_NOT_OPEN"
  | "SESSION_MUST_BE_FUTURE"
  | "INSUFFICIENT_SPOTS";

export type SessionChangeVerdict =
  | { allowed: true }
  | { allowed: false; reason: SessionChangeRejection };

const ALLOWED: SessionChangeVerdict = { allowed: true };

function denied(reason: SessionChangeRejection): SessionChangeVerdict {
  return { allowed: false, reason };
}

/** Texto operacional de cada recusa. É o que aparece no painel. */
export const SESSION_CHANGE_MESSAGES: Record<SessionChangeRejection, string> = {
  RESERVATION_NOT_CONFIRMED: "Só uma reserva confirmada pode trocar de turma.",
  SESSION_NOT_FOUND: "A turma escolhida não existe mais.",
  SAME_SESSION: "Esta já é a turma da reserva.",
  EXPERIENCE_NOT_AVAILABLE: "Esta experiência não está publicada e não pode receber uma reserva de outra experiência.",
  SESSION_NOT_OPEN: "Esta turma não está aberta para receber reservas.",
  SESSION_MUST_BE_FUTURE: "Esta turma já aconteceu.",
  INSUFFICIENT_SPOTS: "Esta turma não tem vagas suficientes para a reserva inteira.",
};

export function sessionChangeMessage(reason: SessionChangeRejection) {
  return SESSION_CHANGE_MESSAGES[reason];
}

/** O que a reserva precisa provar antes de mudar de turma. */
export type SessionChangeReservation = {
  status: ReservationStatus;
  quantity: number;
  sessionId: string;
  experienceId: string;
};

/** O que a turma de destino precisa provar para receber a reserva. */
export type SessionChangeTarget = {
  sessionId: string;
  experienceId: string;
  experienceStatus: ExperienceStatus;
  startsAt: string;
  status: SessionLifecycleStatus;
  capacity: number;
  remainingSpots: number;
};

/**
 * Aplica, na ordem, as mesmas regras da RPC.
 *
 * A checagem de vaga usa a quantidade **inteira** da reserva: não existe mover
 * parte dos participantes, então uma reserva de 3 pessoas precisa de 3 vagas.
 * `remainingSpots` já vem limitado pela capacidade da turma, o que impede a
 * reserva de ultrapassá-la.
 */
export function evaluateSessionChange(
  reservation: SessionChangeReservation,
  target: SessionChangeTarget | null,
  now: Date,
): SessionChangeVerdict {
  if (reservation.status !== "CONFIRMED") return denied("RESERVATION_NOT_CONFIRMED");
  if (!target) return denied("SESSION_NOT_FOUND");
  if (target.sessionId === reservation.sessionId) return denied("SAME_SESSION");
  // Trocar de experiência é permitido; entrar em uma experiência que não está
  // publicada, não. A própria experiência da reserva é sempre aceita — se ela
  // foi despublicada depois da venda, trocar de horário dentro dela continua
  // possível.
  if (target.experienceId !== reservation.experienceId && target.experienceStatus !== "PUBLISHED") {
    return denied("EXPERIENCE_NOT_AVAILABLE");
  }
  if (target.status !== "OPEN") return denied("SESSION_NOT_OPEN");

  const startsAt = new Date(target.startsAt).getTime();
  if (!Number.isFinite(startsAt)) return denied("SESSION_NOT_FOUND");
  if (startsAt <= now.getTime()) return denied("SESSION_MUST_BE_FUTURE");

  if (reservation.quantity > target.remainingSpots) return denied("INSUFFICIENT_SPOTS");
  if (reservation.quantity > target.capacity) return denied("INSUFFICIENT_SPOTS");

  return ALLOWED;
}

/** Veredito de uma opção já recortada pelo banco, sem repetir a leitura. */
export function evaluateOption(
  options: ReservationSessionOptions,
  option: SessionChangeOption,
  now: Date,
): SessionChangeVerdict {
  if (!options.current) return denied("SESSION_NOT_FOUND");
  return evaluateSessionChange(
    {
      status: options.status,
      quantity: options.quantity,
      sessionId: options.current.sessionId,
      experienceId: options.current.experienceId,
    },
    option,
    now,
  );
}

// --- Leitura defensiva do payload da RPC ------------------------------------

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asExperienceStatus(value: unknown): ExperienceStatus {
  const status = asString(value);
  return status === "DRAFT" || status === "PUBLISHED" || status === "ARCHIVED" ? status : "DRAFT";
}

function asSessionStatus(value: unknown): SessionLifecycleStatus {
  const status = asString(value);
  return status === "OPEN" || status === "CLOSED" || status === "CANCELLED" || status === "ARCHIVED"
    ? status
    : "CLOSED";
}

function asReservationStatus(value: unknown): ReservationStatus {
  const status = asString(value);
  return status === "PRE_RESERVED" || status === "CONFIRMED" || status === "EXPIRED" || status === "CANCELLED"
    ? status
    : "EXPIRED";
}

function parseSession(value: unknown): SessionChangeCurrent | null {
  const record = asRecord(value);
  if (!record) return null;
  const sessionId = asString(record.sessionId);
  const startsAt = asString(record.startsAt);
  if (!sessionId || !startsAt) return null;

  return {
    sessionId,
    experienceId: asString(record.experienceId),
    experienceTitle: asString(record.experienceTitle),
    experienceStatus: asExperienceStatus(record.experienceStatus),
    startsAt,
    durationMinutes: asNumber(record.durationMinutes),
    capacity: asNumber(record.capacity),
    remainingSpots: asNumber(record.remainingSpots),
    priceCents: asNumber(record.priceCents),
    status: asSessionStatus(record.status),
  };
}

export function parseReservationSessionOptions(value: unknown): ReservationSessionOptions | null {
  const root = asRecord(value);
  if (!root) return null;
  const reservationId = asString(root.reservationId);
  if (!reservationId) return null;

  const rawOptions = Array.isArray(root.options) ? root.options : [];
  const options = rawOptions
    .map((item) => {
      const session = parseSession(item);
      if (!session) return null;
      const record = asRecord(item);
      return { ...session, fits: record?.fits === true };
    })
    .filter((option): option is SessionChangeOption => option !== null);

  return {
    reservationId,
    publicCode: asString(root.publicCode),
    fullName: asString(root.fullName),
    status: asReservationStatus(root.status),
    quantity: asNumber(root.quantity),
    totalCents: asNumber(root.totalCents),
    unitPriceCents: asNumber(root.unitPriceCents),
    hiddenForCapacity: asNumber(root.hiddenForCapacity),
    current: parseSession(root.current),
    options,
  };
}

/** Resultado devolvido pela RPC de mudança, já tipado. */
export type SessionChangeResult = {
  moved: boolean;
  changeId: string;
  reservationId: string;
  publicCode: string;
  status: ReservationStatus;
  quantity: number;
  totalCents: number;
  /** Valor unitário pago, devolvido pela RPC para a tela reafirmar o que não mudou. */
  unitPriceCents: number;
  /** true quando a reserva passou a pertencer a outra experiência. */
  experienceChanged: boolean;
  previousSessionId: string;
  previousStartsAt: string;
  previousExperienceId: string;
  previousExperienceTitle: string;
  previousSessionPriceCents: number;
  targetSessionId: string;
  targetStartsAt: string;
  targetExperienceId: string;
  targetExperienceTitle: string;
  targetSessionPriceCents: number;
};

export function parseSessionChangeResult(value: unknown): SessionChangeResult | null {
  const record = asRecord(value);
  if (!record || record.moved !== true) return null;
  const previousSessionId = asString(record.previousSessionId);
  const targetSessionId = asString(record.targetSessionId);
  if (!previousSessionId || !targetSessionId) return null;

  return {
    moved: true,
    changeId: asString(record.changeId),
    reservationId: asString(record.reservationId),
    publicCode: asString(record.publicCode),
    status: asReservationStatus(record.status),
    quantity: asNumber(record.quantity),
    totalCents: asNumber(record.totalCents),
    unitPriceCents: asNumber(record.unitPriceCents),
    experienceChanged: record.experienceChanged === true,
    previousSessionId,
    previousStartsAt: asString(record.previousStartsAt),
    previousExperienceId: asString(record.previousExperienceId),
    previousExperienceTitle: asString(record.previousExperienceTitle),
    previousSessionPriceCents: asNumber(record.previousSessionPriceCents),
    targetSessionId,
    targetStartsAt: asString(record.targetStartsAt),
    targetExperienceId: asString(record.targetExperienceId),
    targetExperienceTitle: asString(record.targetExperienceTitle),
    targetSessionPriceCents: asNumber(record.targetSessionPriceCents),
  };
}

/** Uma linha do histórico administrativo de trocas. */
export type ReservationSessionChange = {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorName: string;
  previousSessionId: string;
  previousStartsAt: string;
  previousExperienceId: string;
  previousExperienceTitle: string;
  targetSessionId: string;
  targetStartsAt: string;
  targetExperienceId: string;
  targetExperienceTitle: string;
  /** true quando a troca atravessou a fronteira de duas experiências. */
  experienceChanged: boolean;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  previousSessionPriceCents: number;
  targetSessionPriceCents: number;
  reason: string | null;
};

/** true quando as duas turmas tinham preços diferentes e o valor foi preservado. */
export function priceWasPreserved(change: ReservationSessionChange) {
  return change.previousSessionPriceCents !== change.targetSessionPriceCents;
}

/**
 * A diferença entre o que a reserva pagou e o que a turma de destino custa hoje.
 *
 * É a única coisa que o sistema faz com preço numa troca: **informar**. Nenhuma
 * cobrança complementar, nenhum estorno e nenhuma escrita em `unit_price_cents`
 * saem daqui — `paidCents` é o valor da reserva e continua sendo depois da
 * mudança. Positivo significa que a turma nova custa mais hoje do que o cliente
 * pagou; negativo, menos.
 */
export function priceDifferenceCents(paidUnitPriceCents: number, targetSessionPriceCents: number) {
  return targetSessionPriceCents - paidUnitPriceCents;
}
