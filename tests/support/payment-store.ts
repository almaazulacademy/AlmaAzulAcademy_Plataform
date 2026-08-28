/**
 * Banco de reservas e pagamentos em memória, fiel às RPCs de
 * `202608280001_payment_confirmation_reliability.sql`.
 *
 * ## O que isto é e o que não é
 *
 * **É** um duplo do Supabase que implementa as mesmas transições das RPCs de
 * pagamento, com relógio controlável. Com ele, `confirmPayment()`,
 * `reconcilePendingPayments()` e as rotas rodam **de verdade** nos testes —
 * webhook duplicado, webhook atrasado, gateway fora do ar, confirmações
 * simultâneas e pagamento tardio sem capacidade exercitam o código de produção,
 * não uma cópia dele.
 *
 * **Não é** substituto de rodar o SQL contra um Postgres. Para isso existe
 * `supabase/diagnostics/payment_reliability_selftest.sql`, que roda a mesma
 * matriz de cenários dentro de uma transação com `rollback` no fim, direto no
 * banco. Os dois se complementam: aqui a orquestração, lá o plpgsql.
 */

export type ReservationStatus = "PRE_RESERVED" | "CONFIRMED" | "EXPIRED" | "CANCELLED";

export type StoredReservation = {
  id: string;
  session_id: string;
  public_code: string;
  status: ReservationStatus;
  quantity: number;
  total_cents: number;
  checkout_url: string | null;
  payment_provider: string | null;
  provider_reference: string | null;
  created_at: number;
  expires_at: number;
  confirmed_at: number | null;
  updated_at: number;
  payment_hold_until: number | null;
  payment_hold_started_at: number | null;
  original_expires_at: number | null;
  reconciliation_attempts: number;
  last_reconciled_at: number | null;
  last_reconciliation_code: string | null;
};

export type StoredSession = {
  id: string;
  capacity: number;
  status: "OPEN" | "CLOSED" | "CANCELLED";
};

export type StoredEvent = {
  reservation_id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  amount_cents: number;
  payload: Record<string, unknown>;
  processed_at: number;
};

export type StoredStep = {
  request_id: string;
  source: string;
  step: string;
  outcome: string | null;
  order_id: string | null;
  reservation_id: string | null;
  error_code: string | null;
  http_status: number | null;
  received_at: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Espelha `payment_hold_minutes()` e `payment_hold_max_minutes()`. */
export const HOLD_MINUTES = 30;
export const HOLD_MAX_MINUTES = 180;

type RpcResponse = { data: unknown; error: { message: string } | null };

export class PaymentStore {
  now: number;
  readonly reservations = new Map<string, StoredReservation>();
  readonly sessions = new Map<string, StoredSession>();
  readonly events: StoredEvent[] = [];
  readonly steps: StoredStep[] = [];
  /** Ligado nos testes de indisponibilidade do Supabase. */
  failNextRpc: string | null = null;
  rpcCalls: string[] = [];

  constructor(now = Date.parse("2026-09-01T12:00:00.000Z")) {
    this.now = now;
  }

  advance(minutes: number) {
    this.now += minutes * MINUTE;
  }

  addSession(id: string, capacity: number, status: StoredSession["status"] = "OPEN") {
    this.sessions.set(id, { id, capacity, status });
    return this.sessions.get(id)!;
  }

  addReservation(input: Partial<StoredReservation> & { id: string; session_id: string }) {
    const reservation: StoredReservation = {
      public_code: input.id.slice(0, 10).toUpperCase(),
      status: "PRE_RESERVED",
      quantity: 1,
      total_cents: 7000,
      checkout_url: "https://checkout.infinitepay.io/abc",
      payment_provider: "INFINITEPAY",
      provider_reference: "slug-abc",
      created_at: this.now,
      expires_at: this.now + 2 * HOUR,
      confirmed_at: null,
      updated_at: this.now,
      payment_hold_until: null,
      payment_hold_started_at: null,
      original_expires_at: null,
      reconciliation_attempts: 0,
      last_reconciled_at: null,
      last_reconciliation_code: null,
      ...input,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  /** Espelha `public.available_spots`. */
  availableSpots(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    let occupied = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.session_id !== sessionId) continue;
      if (this.occupies(reservation)) occupied += reservation.quantity;
    }
    return Math.max(0, session.capacity - occupied);
  }

  private occupies(reservation: StoredReservation) {
    return reservation.status === "CONFIRMED"
      || (reservation.status === "PRE_RESERVED" && reservation.expires_at > this.now);
  }

  eventsFor(reservationId: string) {
    return this.events.filter((event) => event.reservation_id === reservationId);
  }

  hasEvent(reservationId: string, eventType: string) {
    return this.eventsFor(reservationId).some((event) => event.event_type === eventType);
  }

  stepsFor(step: string) {
    return this.steps.filter((entry) => entry.step === step);
  }

  private insertEvent(event: Omit<StoredEvent, "processed_at">) {
    // Espelha `unique (provider, provider_event_id)` + `on conflict do nothing`.
    const duplicate = this.events.some(
      (stored) => stored.provider === event.provider && stored.provider_event_id === event.provider_event_id,
    );
    if (duplicate) return false;
    this.events.push({ ...event, processed_at: this.now });
    return true;
  }

  /** Cliente compatível com o subconjunto de supabase-js que o código usa. */
  client() {
    const select = (table: string) => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: async () => {
            if (table !== "reservations") return { data: null, error: null };
            if (this.failNextRpc === "reservations.select") {
              this.failNextRpc = null;
              return { data: null, error: { message: "connection reset" } };
            }
            const found = this.reservations.get(value);
            return { data: found ? this.serialize(found) : null, error: null };
          },
        }),
      }),
    });

    return {
      from: select,
      rpc: async (name: string, args: Record<string, unknown>): Promise<RpcResponse> => this.rpc(name, args),
    } as never;
  }

  private serialize(reservation: StoredReservation) {
    return {
      ...reservation,
      created_at: new Date(reservation.created_at).toISOString(),
      expires_at: new Date(reservation.expires_at).toISOString(),
      updated_at: new Date(reservation.updated_at).toISOString(),
      confirmed_at: reservation.confirmed_at ? new Date(reservation.confirmed_at).toISOString() : null,
      payment_hold_until: reservation.payment_hold_until ? new Date(reservation.payment_hold_until).toISOString() : null,
      original_expires_at: reservation.original_expires_at ? new Date(reservation.original_expires_at).toISOString() : null,
      last_reconciled_at: reservation.last_reconciled_at ? new Date(reservation.last_reconciled_at).toISOString() : null,
    };
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<RpcResponse> {
    this.rpcCalls.push(name);
    if (this.failNextRpc === name) {
      this.failNextRpc = null;
      return { data: null, error: { message: "temporarily unavailable" } };
    }

    switch (name) {
      case "record_payment_attempt": return { data: this.recordPaymentAttempt(args), error: null };
      case "confirm_reservation_payment": return { data: this.confirmReservationPayment(args), error: null };
      case "reconcile_reservation_payment": return { data: this.reconcileReservationPayment(args), error: null };
      case "record_payment_step": return { data: this.recordPaymentStep(args), error: null };
      case "claim_payment_reconciliation": return { data: this.claimReconciliation(args), error: null };
      case "hold_reservation_for_payment_check": return { data: this.holdForPaymentCheck(args), error: null };
      case "release_reservation_payment_hold": return { data: this.releaseHold(args), error: null };
      case "record_reconciliation_result": return { data: this.recordReconciliationResult(args), error: null };
      case "expire_pre_reservations": return { data: this.expirePreReservations(), error: null };
      default: return { data: null, error: null };
    }
  }

  // --- RPCs -----------------------------------------------------------------

  private recordPaymentAttempt(args: Record<string, unknown>) {
    const reservation = this.reservations.get(String(args.p_reservation_id));
    if (!reservation) return false;
    this.insertEvent({
      reservation_id: reservation.id,
      provider: String(args.p_provider || "UNKNOWN"),
      provider_event_id: String(args.p_provider_event_id || `attempt-${this.events.length}`),
      event_type: String(args.p_event_type || "PAYMENT_ATTEMPT"),
      amount_cents: Math.max(Number(args.p_amount_cents) || 0, 0),
      payload: (args.p_payload as Record<string, unknown>) ?? {},
    });
    return true;
  }

  private recordPaymentStep(args: Record<string, unknown>) {
    const orderId = args.p_order_id ? String(args.p_order_id) : null;
    this.steps.push({
      request_id: String(args.p_request_id ?? "unknown"),
      source: String(args.p_source ?? "WEBHOOK"),
      step: String(args.p_step ?? "UNKNOWN_STEP"),
      outcome: args.p_outcome ? String(args.p_outcome) : null,
      order_id: orderId,
      reservation_id: orderId && this.reservations.has(orderId) ? orderId : null,
      error_code: args.p_error_code ? String(args.p_error_code) : null,
      http_status: args.p_http_status === null || args.p_http_status === undefined ? null : Number(args.p_http_status),
      received_at: this.now,
    });
    return `step-${this.steps.length}`;
  }

  private confirmReservationPayment(args: Record<string, unknown>) {
    const reservation = this.reservations.get(String(args.p_reservation_id));
    if (!reservation) return false;
    if (reservation.status === "CONFIRMED") return true;

    const provider = String(args.p_provider);
    const eventId = String(args.p_provider_event_id);
    const amount = Number(args.p_amount_cents);

    if (reservation.status !== "PRE_RESERVED" || reservation.expires_at <= this.now) {
      this.insertEvent({
        reservation_id: reservation.id, provider, provider_event_id: eventId,
        event_type: "PAYMENT_AFTER_EXPIRATION", amount_cents: amount,
        payload: { receipt_url: String(args.p_receipt_url ?? "") },
      });
      if (reservation.status === "PRE_RESERVED") {
        reservation.status = "EXPIRED";
        reservation.updated_at = this.now;
      }
      return false;
    }
    if (reservation.total_cents !== amount) return false;

    this.insertEvent({
      reservation_id: reservation.id, provider, provider_event_id: eventId,
      event_type: "PAYMENT_CONFIRMED", amount_cents: amount,
      payload: { receipt_url: String(args.p_receipt_url ?? "") },
    });
    reservation.status = "CONFIRMED";
    reservation.confirmed_at = this.now;
    reservation.provider_reference = eventId;
    reservation.payment_hold_until = null;
    reservation.last_reconciled_at = this.now;
    reservation.last_reconciliation_code = "CONFIRMED";
    reservation.updated_at = this.now;
    return true;
  }

  private reconcileReservationPayment(args: Record<string, unknown>) {
    const reservation = this.reservations.get(String(args.p_reservation_id));
    if (!reservation) return "NOT_FOUND";
    if (reservation.status === "CONFIRMED") return "ALREADY_CONFIRMED";
    if (reservation.status === "CANCELLED") {
      reservation.last_reconciliation_code = "CANCELLED";
      return "CANCELLED";
    }

    const provider = String(args.p_provider);
    const eventId = String(args.p_provider_event_id);
    const amount = Number(args.p_amount_cents);

    if (reservation.total_cents !== amount) {
      this.insertEvent({
        reservation_id: reservation.id, provider, provider_event_id: `${eventId}:mismatch`,
        event_type: "PAYMENT_AMOUNT_MISMATCH", amount_cents: Math.max(amount, 0),
        payload: { expected_cents: reservation.total_cents },
      });
      reservation.last_reconciliation_code = "AMOUNT_MISMATCH";
      reservation.last_reconciled_at = this.now;
      return "AMOUNT_MISMATCH";
    }

    const session = this.sessions.get(reservation.session_id);
    if (!session) return "NOT_FOUND";
    if (session.status === "CANCELLED") {
      reservation.last_reconciliation_code = "SESSION_CANCELLED";
      return "SESSION_CANCELLED";
    }

    let occupied = 0;
    for (const other of this.reservations.values()) {
      if (other.session_id !== reservation.session_id || other.id === reservation.id) continue;
      if (other.status === "PRE_RESERVED" && other.expires_at <= this.now) {
        other.status = "EXPIRED";
        other.updated_at = this.now;
      }
      if (this.occupies(other)) occupied += other.quantity;
    }

    if (occupied + reservation.quantity > session.capacity) {
      this.insertEvent({
        reservation_id: reservation.id, provider, provider_event_id: `${eventId}:no-capacity`,
        event_type: "PAYMENT_AFTER_EXPIRATION_NO_CAPACITY", amount_cents: Math.max(amount, 0),
        payload: { occupied, capacity: session.capacity },
      });
      if (reservation.status === "PRE_RESERVED") {
        reservation.expires_at = Math.min(reservation.expires_at, this.now);
        reservation.payment_hold_until = this.now;
      }
      reservation.last_reconciliation_code = "NO_CAPACITY";
      reservation.last_reconciled_at = this.now;
      reservation.updated_at = this.now;
      return "NO_CAPACITY";
    }

    this.insertEvent({
      reservation_id: reservation.id, provider, provider_event_id: `${eventId}:reconciled`,
      event_type: "PAYMENT_CONFIRMED_RECONCILED", amount_cents: amount,
      payload: { previous_status: reservation.status, receipt_url: String(args.p_receipt_url ?? "") },
    });
    reservation.status = "CONFIRMED";
    reservation.confirmed_at = reservation.confirmed_at ?? this.now;
    reservation.provider_reference = reservation.provider_reference ?? eventId;
    reservation.expires_at = Math.max(reservation.expires_at, this.now + HOUR);
    reservation.payment_hold_until = null;
    reservation.last_reconciliation_code = "RECONCILED";
    reservation.last_reconciled_at = this.now;
    reservation.updated_at = this.now;
    return "RECONCILED";
  }

  /** Espelha os três passos de `expire_pre_reservations()`. */
  expirePreReservations() {
    for (const reservation of this.reservations.values()) {
      if (reservation.status !== "PRE_RESERVED") continue;
      if (reservation.expires_at > this.now) continue;
      if (reservation.payment_hold_until !== null) continue;
      if (!reservation.checkout_url) continue;

      reservation.original_expires_at = reservation.original_expires_at ?? reservation.expires_at;
      reservation.payment_hold_started_at = this.now;
      const until = Math.max(reservation.expires_at + HOLD_MINUTES * MINUTE, this.now + MINUTE);
      reservation.payment_hold_until = until;
      reservation.expires_at = until;
      reservation.updated_at = this.now;
      this.insertEvent({
        reservation_id: reservation.id,
        provider: reservation.payment_provider ?? "UNKNOWN",
        provider_event_id: `hold:${reservation.id}`,
        event_type: "EXPIRATION_HELD_FOR_PAYMENT_CHECK",
        amount_cents: 0,
        payload: { original_expires_at: reservation.original_expires_at, payment_hold_until: until },
      });
    }

    for (const reservation of this.reservations.values()) {
      if (reservation.status !== "PRE_RESERVED") continue;
      if (reservation.expires_at > this.now) continue;
      if (reservation.payment_hold_until === null) continue;
      if (reservation.last_reconciliation_code === "NOT_PAID") continue;
      this.insertEvent({
        reservation_id: reservation.id,
        provider: reservation.payment_provider ?? "UNKNOWN",
        provider_event_id: `hold-exhausted:${reservation.id}`,
        event_type: "PAYMENT_HOLD_EXHAUSTED",
        amount_cents: 0,
        payload: {
          reconciliation_attempts: reservation.reconciliation_attempts,
          last_reconciliation_code: reservation.last_reconciliation_code,
        },
      });
    }

    let expired = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.status !== "PRE_RESERVED") continue;
      if (reservation.expires_at > this.now) continue;
      reservation.status = "EXPIRED";
      reservation.updated_at = this.now;
      expired += 1;
    }
    return expired;
  }

  private holdForPaymentCheck(args: Record<string, unknown>) {
    const reservation = this.reservations.get(String(args.p_reservation_id));
    if (!reservation || reservation.status !== "PRE_RESERVED") return null;

    const baseline = reservation.original_expires_at ?? reservation.expires_at;
    const ceiling = baseline + HOLD_MAX_MINUTES * MINUTE;
    const minutes = Math.max(Number(args.p_minutes) || HOLD_MINUTES, 1);
    const until = Math.min(this.now + minutes * MINUTE, ceiling);

    reservation.original_expires_at = baseline;
    reservation.payment_hold_started_at = reservation.payment_hold_started_at ?? this.now;
    reservation.payment_hold_until = Math.max(reservation.payment_hold_until ?? until, until);
    reservation.expires_at = Math.max(reservation.expires_at, until);
    reservation.last_reconciled_at = this.now;
    const code = String(args.p_code ?? "");
    if (/^[A-Z0-9_]{1,64}$/.test(code)) reservation.last_reconciliation_code = code;
    reservation.updated_at = this.now;
    return new Date(reservation.payment_hold_until).toISOString();
  }

  private releaseHold(args: Record<string, unknown>) {
    const code = String(args.p_code ?? "").trim().toUpperCase();
    if (!["NOT_PAID", "CANCELLED", "SESSION_CANCELLED", "RESERVATION_NOT_FOUND"].includes(code)) return false;
    const reservation = this.reservations.get(String(args.p_reservation_id));
    if (!reservation || reservation.status !== "PRE_RESERVED" || reservation.payment_hold_until === null) return false;

    reservation.expires_at = Math.min(reservation.expires_at, this.now);
    reservation.payment_hold_until = this.now;
    reservation.last_reconciled_at = this.now;
    reservation.last_reconciliation_code = code;
    reservation.updated_at = this.now;
    return true;
  }

  private recordReconciliationResult(args: Record<string, unknown>) {
    const reservation = this.reservations.get(String(args.p_reservation_id));
    if (!reservation) return false;
    const code = String(args.p_code ?? "");
    if (/^[A-Z0-9_]{1,64}$/.test(code)) reservation.last_reconciliation_code = code;
    reservation.last_reconciled_at = this.now;
    return true;
  }

  private claimReconciliation(args: Record<string, unknown>) {
    const limit = Math.min(Math.max(Number(args.p_limit) || 10, 1), 50);
    const stale = Math.max(Number(args.p_stale_minutes) || 5, 1) * MINUTE;
    const lookback = Math.max(Number(args.p_lookback_hours) || 72, 1) * HOUR;

    const confirmingEvents = new Set(["PAYMENT_CONFIRMED", "PAYMENT_CONFIRMED_MANUAL", "PAYMENT_CONFIRMED_RECONCILED"]);
    const signalEvents = new Set([
      "PAYMENT_WEBHOOK_RECEIVED", "PAYMENT_NOT_CONFIRMED", "PAYMENT_AMOUNT_MISMATCH",
      "PAYMENT_AFTER_EXPIRATION", "PAYMENT_HOLD_EXHAUSTED",
    ]);

    const candidates = [...this.reservations.values()]
      .filter((reservation) => {
        if (!["PRE_RESERVED", "EXPIRED"].includes(reservation.status)) return false;
        if (!reservation.checkout_url) return false;

        const recentlyChecked = reservation.last_reconciled_at !== null
          && reservation.last_reconciled_at >= this.now - stale;
        const closing = reservation.expires_at <= this.now + 5 * MINUTE;
        if (recentlyChecked && !closing) return false;

        if (this.eventsFor(reservation.id).some((event) => confirmingEvents.has(event.event_type))) return false;

        const aboutToExpire = reservation.status === "PRE_RESERVED" && reservation.expires_at <= this.now + 10 * MINUTE;
        const onHold = reservation.status === "PRE_RESERVED"
          && reservation.payment_hold_until !== null && reservation.payment_hold_until > this.now;
        const recentlyExpired = reservation.status === "EXPIRED" && reservation.updated_at > this.now - lookback;
        const hasSignal = this.eventsFor(reservation.id).some(
          (event) => signalEvents.has(event.event_type) && event.processed_at > this.now - lookback,
        );
        return aboutToExpire || onHold || recentlyExpired || hasSignal;
      })
      .sort((a, b) => a.expires_at - b.expires_at)
      .slice(0, limit);

    return candidates.map((reservation) => {
      reservation.reconciliation_attempts += 1;
      reservation.last_reconciled_at = this.now;
      reservation.updated_at = this.now;
      return {
        reservation_id: reservation.id,
        reservation_status: reservation.status,
        expires_at: new Date(reservation.expires_at).toISOString(),
        payment_hold_until: reservation.payment_hold_until ? new Date(reservation.payment_hold_until).toISOString() : null,
        original_expires_at: reservation.original_expires_at ? new Date(reservation.original_expires_at).toISOString() : null,
        total_cents: reservation.total_cents,
        provider_reference: reservation.provider_reference,
        reconciliation_attempts: reservation.reconciliation_attempts,
      };
    });
  }
}

/** Provedor de pagamento controlável, com o mesmo contrato do real. */
export class FakeProvider {
  readonly name = "INFINITEPAY";
  calls = 0;
  private readonly behaviour: (call: number) => { paid: boolean; chargedCents?: number } | Error;

  constructor(behaviour: (call: number) => { paid: boolean; chargedCents?: number } | Error) {
    this.behaviour = behaviour;
  }

  async createCheckout(): Promise<never> {
    throw new Error("não usado nos testes de confirmação");
  }

  async verifyPayment(request: { orderId: string; transactionId: string; invoiceSlug: string; expectedAmountCents: number }) {
    this.calls += 1;
    const outcome = this.behaviour(this.calls);
    if (outcome instanceof Error) throw outcome;
    const charged = outcome.chargedCents ?? request.expectedAmountCents;
    return {
      paid: outcome.paid,
      amountCents: outcome.paid ? request.expectedAmountCents : charged,
      chargedAmountCents: charged,
      transactionId: request.transactionId,
      invoiceSlug: request.invoiceSlug,
      receiptUrl: "https://recibo.infinitepay.io/x",
      raw: { success: true, paid: outcome.paid, amount: charged },
    };
  }
}
