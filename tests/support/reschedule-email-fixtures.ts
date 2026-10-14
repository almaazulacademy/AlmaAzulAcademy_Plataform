/**
 * Cenários e operações da fila do e-mail de reagendamento, para os testes.
 *
 * Tudo aqui fala com o banco por uma única função `query(sql, params)`, sem
 * saber qual é o banco: o Postgres em memória (PGlite) dos testes comuns ou um
 * Postgres de verdade, com várias conexões, nos testes de concorrência. As
 * reservas são criadas pelos caminhos reais — pré-reserva, pagamento, Stand-by,
 * reagendamento — e a fila é operada pelas mesmas RPCs que o servidor chama.
 *
 * Também traz um provedor de e-mail falso que segue o contrato documentado da
 * chave de idempotência do Resend. Nenhum e-mail é enviado.
 */

import assert from "node:assert/strict";

import { EmailProviderError, type EmailMessage } from "../../lib/email/email-provider.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

export const ADMIN = "c0000000-0000-4000-8000-000000000001";
export const INSTRUCTOR = "c0000000-0000-4000-8000-000000000002";
export const STRANGER = "c0000000-0000-4000-8000-000000000003";

/** A política de produção, repetida aqui para os testes chamarem as RPCs direto. */
export const MAX_ATTEMPTS = 6;
export const LEASE_MINUTES = 2;
export const WINDOW_MINUTES = 23 * 60;

export type Booking = { id: string; cpf: string; code: string; total: number; quantity: number; name: string; email: string };

export type FailureKind = "REJECTED" | "UNKNOWN" | "KEY_REFUSED";

export async function rescheduleFixtures(query: Query) {
  async function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return query(sql, params);
  }

  async function one(sql: string, params: unknown[] = []): Promise<Row> {
    const result = await rows(sql, params);
    assert.ok(result.length >= 1, `sem linhas: ${sql}`);
    return result[0];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(expression: string, params: unknown[] = []): Promise<any> {
    return (await one(`select ${expression} as value`, params)).value;
  }

  // --- Equipe -----------------------------------------------------------------

  await rows(
    `insert into auth.users (id, email) values
       ($1::uuid, 'admin@teste.local'), ($2::uuid, 'instrutor@teste.local'), ($3::uuid, 'estranho@teste.local')
     on conflict do nothing`,
    [ADMIN, INSTRUCTOR, STRANGER],
  );
  await rows(
    `insert into public.admin_users (user_id, display_name, role, is_active) values
       ($1::uuid, 'Admin Teste', 'ADMIN', true), ($2::uuid, 'Instrutor Teste', 'INSTRUCTOR', true)
     on conflict do nothing`,
    [ADMIN, INSTRUCTOR],
  );

  // --- Catálogo ---------------------------------------------------------------

  async function experience(slug: string) {
    return one(
      `select e.id, e.title, b.id as base_id, b.slug as base_slug, b.name as base_name, b.address, b.meeting_point, b.maps_url
       from public.experiences e join public.bases b on b.id = e.base_id where e.slug = $1`,
      [slug],
    );
  }

  const IMERSAO = await experience("imersao-paranoa"); // Lago Norte
  const SUNSET_CONCHA = await experience("remada-sunset-concha-acustica"); // Cápsula Bar — Concha Acústica

  let sequence = 0;

  /** Cada cenário usa um preço próprio: a régua do mesmo valor isola as turmas. */
  function uniquePrice() {
    sequence += 1;
    return 40_000 + sequence * 100;
  }

  async function makeSession(experienceId: string, options: { price: number; capacity?: number; startsIn?: string }) {
    sequence += 1;
    const created = await one(
      `insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status)
       values ($1::uuid, now() + $2::interval + make_interval(secs => $3), 90, $4, $5, 'OPEN')
       returning id`,
      [experienceId, options.startsIn ?? "10 days", sequence, options.price, options.capacity ?? 6],
    );
    return created.id as string;
  }

  /** Reserva confirmada pelo caminho real de pagamento. */
  async function reserve(sessionId: string, quantity = 2, name?: string): Promise<Booking> {
    sequence += 1;
    const cpf = String(30_000_000_000 + sequence);
    const fullName = name ?? `Cliente Reagendado ${sequence}`;
    const email = `reagendado${sequence}@teste.local`;
    const created = await call(
      `public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, gen_random_uuid())`,
      [sessionId, fullName, cpf, `+55619${String(20_000_000 + sequence)}`, email, quantity],
    );
    const confirmed = await call(
      `public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`,
      [created.reservationId, `tx-${cpf}`, created.totalCents],
    );
    assert.equal(confirmed, true);
    return { id: created.reservationId, cpf, code: created.publicCode, total: created.totalCents, quantity, name: fullName, email };
  }

  function setStandby(reservationId: string) {
    return call(`public.admin_set_reservation_standby($1::uuid, $2::uuid, 'Turma cancelada por mau tempo')`, [ADMIN, reservationId]);
  }

  /** O reagendamento que o painel usa. */
  function reschedule(reservationId: string, sessionId: string) {
    return call(`public.admin_reschedule_standby_same_price($1::uuid, $2::uuid, $3::uuid, 'Cliente escolheu por telefone')`, [ADMIN, reservationId, sessionId]);
  }

  function reservation(id: string) {
    return one(`select * from public.reservations where id = $1::uuid`, [id]);
  }

  function emails(reservationId: string) {
    return rows(`select * from public.reservation_reschedule_emails where reservation_id = $1::uuid order by created_at, id`, [reservationId]);
  }

  async function email(emailId: string) {
    return one(`select * from public.reservation_reschedule_emails where id = $1::uuid`, [emailId]);
  }

  function attempts(emailId: string) {
    return rows(`select * from public.reservation_reschedule_email_attempts where email_id = $1::uuid order by attempt`, [emailId]);
  }

  async function queueSize() {
    return (await one(`select count(*)::int as n from public.reservation_reschedule_emails`)).n as number;
  }

  /**
   * Uma reserva confirmada no Lago Norte, colocada em Stand-by e reagendada pelo
   * painel — por padrão, para uma turma de outra base. É o ponto de partida da
   * maioria dos cenários.
   */
  async function rescheduled(options: { quantity?: number; name?: string; targetExperienceId?: string; startsIn?: string } = {}) {
    const price = uniquePrice();
    const origin = await makeSession(IMERSAO.id, { price });
    const destination = await makeSession(options.targetExperienceId ?? SUNSET_CONCHA.id, { price, startsIn: options.startsIn ?? "14 days" });
    const booking = await reserve(origin, options.quantity ?? 2, options.name);
    await setStandby(booking.id);
    const resolution = await reschedule(booking.id, destination);
    const [queued] = await emails(booking.id);
    return { booking, origin, destination, price, resolution, emailId: queued.id as string, changeId: resolution.changeId as string };
  }

  // --- Fila, pelas RPCs que o servidor chama ---------------------------------

  function claimFor(changeId: string, maxAttempts = MAX_ATTEMPTS) {
    return call(`public.claim_reservation_reschedule_email($1::uuid, $2, $3, $4)`, [changeId, maxAttempts, LEASE_MINUTES, WINDOW_MINUTES]);
  }

  function claimPending(limit = 25, maxAttempts = MAX_ATTEMPTS) {
    return call(`public.claim_pending_reservation_reschedule_emails($1, $2, $3, $4)`, [limit, maxAttempts, LEASE_MINUTES, WINDOW_MINUTES]);
  }

  /** `acceptUncertain`: a pessoa aceitou o risco de duplicidade de uma entrega não confirmada. */
  function adminClaim(reservationId: string, actor = ADMIN, acceptUncertain = false) {
    return call(`public.admin_claim_reservation_reschedule_email($1::uuid, $2::uuid, $3, $4, $5)`, [actor, reservationId, LEASE_MINUTES, WINDOW_MINUTES, acceptUncertain]);
  }

  function freeze(emailId: string, token: string, message: { to: string; subject: string; html: string; text: string } | Row | null) {
    return call(`public.freeze_reservation_reschedule_email($1::uuid, $2::uuid, $3::jsonb)`, [emailId, token, message === null ? null : JSON.stringify(message)]);
  }

  function complete(emailId: string, token: string) {
    return call(`public.complete_reservation_reschedule_email($1::uuid, $2::uuid)`, [emailId, token]);
  }

  /** Sem `retryAfterSeconds`, a espera é zero: a próxima tentativa já está liberada. */
  function fail(emailId: string, token: string, code: string, kind: FailureKind | string = "REJECTED", retryAfterSeconds = 0) {
    return call(`public.fail_reservation_reschedule_email($1::uuid, $2::uuid, $3, $4, $5)`, [emailId, token, code, kind, retryAfterSeconds]);
  }

  /** Uma mensagem qualquer para o destinatário da reserva: o que o servidor congelaria. */
  async function messageFor(reservationId: string, marker = "v1") {
    const { email: to } = await reservation(reservationId);
    return { to: to as string, subject: `Reagendamento confirmado (${marker})`, html: `<p>${marker}</p>`, text: marker };
  }

  /** Reivindica e congela: a tentativa chegou à fase de envio. */
  async function claimAndFreeze(changeId: string, reservationId: string, marker = "v1") {
    const claim = await claimFor(changeId);
    assert.ok(claim, "a reivindicação precisa ser obtida");
    if (claim.message === null) assert.equal(await freeze(claim.emailId, claim.claimToken, await messageFor(reservationId, marker)), true);
    return claim;
  }

  // --- Passagem do tempo ------------------------------------------------------

  /** Simula a passagem do prazo de uma reivindicação. */
  async function expireLease(emailId: string) {
    await rows(`update public.reservation_reschedule_emails set locked_until = now() - interval '1 minute' where id = $1::uuid and status = 'SENDING'`, [emailId]);
  }

  /** Simula a passagem da espera entre tentativas. */
  async function skipBackoff(emailId?: string) {
    await rows(
      `update public.reservation_reschedule_emails set next_attempt_at = now() - interval '1 second'
       where next_attempt_at is not null and ($1::uuid is null or id = $1::uuid)`,
      [emailId ?? null],
    );
  }

  /** Simula a passagem do tempo desde o primeiro uso da chave de idempotência atual. */
  async function ageGeneration(emailId: string, age: string) {
    await rows(`update public.reservation_reschedule_emails set generation_started_at = now() - $2::interval where id = $1::uuid`, [emailId, age]);
  }

  /** Encerra tudo o que ficou aberto na fila: cada cenário começa com ela vazia. */
  async function settleQueue() {
    await rows(
      `update public.reservation_reschedule_emails
       set status = 'SKIPPED', last_error_code = 'TEST_CLEANUP', locked_until = null, next_attempt_at = null, frozen_message = null
       where status in ('QUEUED', 'SENDING', 'FAILED', 'UNCERTAIN')`,
    );
  }

  return {
    rows, one, call,
    IMERSAO, SUNSET_CONCHA,
    uniquePrice, makeSession, reserve, setStandby, reschedule, reservation, rescheduled,
    emails, email, attempts, queueSize,
    claimFor, claimPending, adminClaim, freeze, complete, fail, messageFor, claimAndFreeze,
    expireLease, skipBackoff, ageGeneration, settleQueue,
  };
}

export type RescheduleFixtures = Awaited<ReturnType<typeof rescheduleFixtures>>;

// --- Provedor falso ----------------------------------------------------------

/** O que o provedor faz com o próximo pedido. */
export type ProviderBehaviour =
  /** Aceita e responde 200. */
  | "ok"
  /** Aceita o pedido, mas a resposta nunca chega a quem enviou: para o servidor, timeout. */
  | "accepted-then-timeout"
  /** Aceita o pedido e responde 500 em seguida. */
  | "accepted-then-500"
  /** O pedido não chega ao provedor: erro de rede, e nada foi aceito. */
  | "lost"
  /** Outro pedido com a mesma chave ainda está em curso. */
  | "in-progress"
  /** O provedor recusa antes de olhar a chave: 401, 403, 422, 429… */
  | EmailProviderError;

const DAY = 24 * 60 * 60 * 1000;

/** O 409 do Resend, como o cliente do provedor o entrega: sem dizer qual dos dois é. */
export const keyRefused = () => new EmailProviderError("HTTP_409", true, "KEY_REFUSED");

/**
 * Provedor de e-mail falso que segue o contrato documentado do Resend para a
 * chave de idempotência:
 *
 *   * a chave vale por 24 horas a partir do primeiro pedido aceito;
 *   * mesma chave + mesmo corpo → a resposta original, **sem entregar de novo**;
 *   * mesma chave + corpo diferente → 409 `invalid_idempotent_request`;
 *   * pedido com a mesma chave ainda em curso → 409 `concurrent_idempotent_requests`;
 *   * depois de 24 horas a chave não existe mais: o pedido é um e-mail novo.
 *
 * Os dois 409 chegam a quem enviou do mesmo jeito que em produção: só o status,
 * sem o nome do erro, porque o corpo da resposta não é lido.
 *
 * `delivered` é o que de fato chegou a uma caixa de entrada — é por ele, e não
 * pelo número de pedidos, que os testes medem "o cliente recebeu duas vezes?".
 * A documentação não diz se pedidos recusados registram a chave;
 * `registerRejections` permite exercitar as duas possibilidades.
 */
export function fakeResend(options: { registerRejections?: boolean } = {}) {
  const requests: EmailMessage[] = [];
  const delivered: EmailMessage[] = [];
  const keys = new Map<string, { body: string; at: number; rejection: EmailProviderError | null }>();
  const script: ProviderBehaviour[] = [];
  let clock = Date.now();

  const bodyOf = (message: EmailMessage) => JSON.stringify({ to: message.to, subject: message.subject, html: message.html, text: message.text });

  return {
    name: "FAKE_RESEND",
    requests,
    delivered,
    /** Os próximos pedidos recebem estes comportamentos, na ordem. Depois, "ok". */
    next(...behaviours: ProviderBehaviour[]) {
      script.push(...behaviours);
    },
    /** Avança o relógio do provedor. */
    advance(hours: number) {
      clock += hours * 60 * 60 * 1000;
    },
    deliveredTo(address: string) {
      return delivered.filter((message) => message.to === address);
    },
    async send(message: EmailMessage) {
      requests.push(message);
      const behaviour = script.shift() ?? "ok";

      if (behaviour === "lost") throw new EmailProviderError("NETWORK_ERROR", true, "UNKNOWN");
      if (behaviour === "in-progress") throw keyRefused();

      const key = message.idempotencyKey;
      const body = bodyOf(message);
      const seen = key ? keys.get(key) : undefined;
      const known = seen && clock - seen.at < DAY ? seen : undefined;

      if (behaviour instanceof EmailProviderError) {
        if (key && options.registerRejections && !known) keys.set(key, { body, at: clock, rejection: behaviour });
        throw behaviour;
      }

      if (known) {
        if (known.body !== body) throw keyRefused();
        // Mesma chave, mesmo corpo: a resposta do primeiro pedido, sem nova entrega.
        if (known.rejection) throw known.rejection;
      } else {
        if (key) keys.set(key, { body, at: clock, rejection: null });
        delivered.push(message);
      }

      if (behaviour === "accepted-then-timeout") throw new EmailProviderError("TIMEOUT", true, "UNKNOWN");
      if (behaviour === "accepted-then-500") throw new EmailProviderError("HTTP_500", true, "UNKNOWN");
    },
  };
}

export type FakeResend = ReturnType<typeof fakeResend>;
