-- Self-test da confiabilidade de confirmação de pagamento.
--
-- Roda a matriz de cenários de falha contra um **Postgres de verdade**, com o
-- plpgsql real de `202608280001_payment_confirmation_reliability.sql`. É o
-- complemento de banco dos testes de `tests/payment-reliability.test.ts`, que
-- exercitam a orquestração em TypeScript.
--
-- ## Segurança
--
-- O arquivo inteiro é um único bloco que **termina levantando exceção de
-- propósito**. Isso aborta a transação e desfaz tudo: não existe caminho em que
-- este script deixe uma linha para trás, mesmo que o operador esqueça o
-- `rollback`. Sucesso e falha são distinguidos pela mensagem:
--
--   SELFTEST_OK        → todos os cenários passaram
--   SELFTEST_FALHOU: … → um cenário quebrou, e a mensagem diz qual
--
-- ## Onde rodar
--
-- Preferencialmente em um banco de **staging**. O script chama
-- `expire_pre_reservations()`, que varre a tabela inteira: em produção isso
-- toma lock de linha nas pré-reservas vigentes por alguns instantes, ainda que
-- nada seja persistido.
--
-- ## Pré-requisito
--
-- A migration 202608280001 precisa estar aplicada. Sem ela, o script falha na
-- primeira chamada de `hold_reservation_for_payment_check`.
--
-- ## Como rodar
--
--   SQL Editor do Supabase → colar → Run
--
-- Não precisa de `begin`/`rollback` manual: o bloco cuida disso.

do $$
declare
  template_session public.sessions%rowtype;
  session_a uuid;
  session_b uuid;
  reserva_a uuid;
  reserva_b uuid;
  reserva_c uuid;
  criacao jsonb;
  resultado text;
  confirmou boolean;
  vagas integer;
  hold_ate timestamptz;
  contagem integer;
  falhas text[] := array[]::text[];

  procedure_note text;
begin
  -- Sessão-modelo: copiar uma linha real mantém compatibilidade com qualquer
  -- coluna legada NOT NULL que este banco tenha e o repositório não conheça.
  select * into template_session from public.sessions order by created_at desc limit 1;
  if not found then
    raise exception 'SELFTEST_FALHOU: o banco não tem nenhuma sessão para usar de modelo';
  end if;

  -- Duas turmas de teste, ambas no futuro. A de capacidade 1 serve aos cenários
  -- de disputa por vaga; a de capacidade 3, aos de recuperação.
  session_a := gen_random_uuid();
  session_b := gen_random_uuid();

  insert into public.sessions
  select (jsonb_populate_record(null::public.sessions,
    to_jsonb(template_session) || jsonb_build_object(
      'id', session_a, 'starts_at', now() + interval '30 days',
      'capacity', 1, 'status', 'OPEN', 'created_at', now(), 'updated_at', now()
    ))).*;

  insert into public.sessions
  select (jsonb_populate_record(null::public.sessions,
    to_jsonb(template_session) || jsonb_build_object(
      'id', session_b, 'starts_at', now() + interval '31 days',
      'capacity', 3, 'status', 'OPEN', 'created_at', now(), 'updated_at', now()
    ))).*;

  -- ========================================================================
  -- Cenário 1 — a expiração retém em vez de liberar cegamente
  -- ========================================================================
  criacao := public.create_pre_reservation(
    session_a, 'Cliente Selftest Um', '11144477735', '61999990000',
    'selftest-1@example.test', 1, '', gen_random_uuid()
  );
  reserva_a := (criacao ->> 'reservationId')::uuid;

  -- Sem checkout vinculado, a reserva não pode ter sido paga: precisa expirar
  -- direto, sem consumir janela de segurança.
  update public.reservations set expires_at = now() - interval '1 minute' where id = reserva_a;
  perform public.expire_pre_reservations();

  if (select status from public.reservations where id = reserva_a) <> 'EXPIRED' then
    falhas := falhas || 'C1a: pré-reserva sem checkout deveria expirar direto';
  end if;
  if exists (select 1 from public.payment_events where reservation_id = reserva_a and event_type = 'EXPIRATION_HELD_FOR_PAYMENT_CHECK') then
    falhas := falhas || 'C1b: pré-reserva sem checkout não deveria entrar em janela de segurança';
  end if;

  -- Agora com checkout: é o caso do incidente real.
  criacao := public.create_pre_reservation(
    session_a, 'Cliente Selftest Dois', '11144477735', '61999990000',
    'selftest-2@example.test', 1, '', gen_random_uuid()
  );
  reserva_b := (criacao ->> 'reservationId')::uuid;
  perform public.attach_payment_checkout(reserva_b, 'INFINITEPAY', 'slug-selftest', 'https://checkout.infinitepay.io/selftest');

  update public.reservations set expires_at = now() - interval '1 minute' where id = reserva_b;
  perform public.expire_pre_reservations();

  if (select status from public.reservations where id = reserva_b) <> 'PRE_RESERVED' then
    falhas := falhas || 'C1c: pré-reserva com checkout não podia ser expirada sem verificar o pagamento';
  end if;
  if not exists (select 1 from public.payment_events where reservation_id = reserva_b and event_type = 'EXPIRATION_HELD_FOR_PAYMENT_CHECK') then
    falhas := falhas || 'C1d: a retenção precisa deixar registro';
  end if;
  if (select original_expires_at from public.reservations where id = reserva_b) is null then
    falhas := falhas || 'C1e: o prazo original precisa ser preservado';
  end if;

  -- E a vaga continua ocupada. Este é o comportamento que impede o overbooking.
  if public.available_spots(session_a) <> 0 then
    falhas := falhas || format('C1f: a vaga não podia ser liberada durante a janela (available_spots=%s)', public.available_spots(session_a));
  end if;

  -- ========================================================================
  -- Cenário 2 — confirmação dentro da janela de segurança
  -- ========================================================================
  confirmou := public.confirm_reservation_payment(
    reserva_b, 'INFINITEPAY', 'tx-selftest-1',
    (select total_cents from public.reservations where id = reserva_b),
    'https://recibo.infinitepay.io/x', '{"stage":"selftest"}'::jsonb
  );
  if not confirmou then
    falhas := falhas || 'C2a: pagamento chegando dentro da janela de segurança precisa confirmar';
  end if;
  if (select status from public.reservations where id = reserva_b) <> 'CONFIRMED' then
    falhas := falhas || 'C2b: a reserva precisa ficar CONFIRMED';
  end if;
  if (select payment_hold_until from public.reservations where id = reserva_b) is not null then
    falhas := falhas || 'C2c: a confirmação precisa limpar a retenção';
  end if;

  -- Idempotência: repetir a mesma confirmação não duplica evento nem estado.
  confirmou := public.confirm_reservation_payment(
    reserva_b, 'INFINITEPAY', 'tx-selftest-1',
    (select total_cents from public.reservations where id = reserva_b),
    'https://recibo.infinitepay.io/x', '{"stage":"selftest"}'::jsonb
  );
  select count(*) into contagem from public.payment_events
  where reservation_id = reserva_b and event_type = 'PAYMENT_CONFIRMED';
  if not confirmou or contagem <> 1 then
    falhas := falhas || format('C2d: confirmação repetida precisa ser idempotente (eventos=%s)', contagem);
  end if;

  -- ========================================================================
  -- Cenário 3 — liberar a vaga exige veredito definitivo
  -- ========================================================================
  criacao := public.create_pre_reservation(
    session_b, 'Cliente Selftest Tres', '11144477735', '61999990000',
    'selftest-3@example.test', 1, '', gen_random_uuid()
  );
  reserva_c := (criacao ->> 'reservationId')::uuid;
  perform public.attach_payment_checkout(reserva_c, 'INFINITEPAY', 'slug-selftest-3', 'https://checkout.infinitepay.io/selftest3');
  update public.reservations set expires_at = now() - interval '1 minute' where id = reserva_c;
  perform public.expire_pre_reservations();

  -- Gateway fora do ar não libera nada.
  if public.release_reservation_payment_hold(reserva_c, 'PROVIDER_UNAVAILABLE') then
    falhas := falhas || 'C3a: incerteza do gateway jamais pode devolver a vaga';
  end if;
  if (select status from public.reservations where id = reserva_c) <> 'PRE_RESERVED' then
    falhas := falhas || 'C3b: a reserva precisa continuar retida';
  end if;

  -- A retenção se estende, mas não passa do teto contado do prazo original.
  hold_ate := public.hold_reservation_for_payment_check(reserva_c, 600, 'PROVIDER_UNAVAILABLE');
  if hold_ate > (select original_expires_at from public.reservations where id = reserva_c)
                + make_interval(mins => public.payment_hold_max_minutes()) then
    falhas := falhas || 'C3c: a retenção passou do teto absoluto';
  end if;

  -- Resposta definitiva libera.
  if not public.release_reservation_payment_hold(reserva_c, 'NOT_PAID') then
    falhas := falhas || 'C3d: veredito definitivo precisa devolver a vaga';
  end if;
  perform public.expire_pre_reservations();
  if (select status from public.reservations where id = reserva_c) <> 'EXPIRED' then
    falhas := falhas || 'C3e: reserva comprovadamente não paga precisa expirar';
  end if;
  -- E, por ser definitiva, não vira incidente.
  if exists (select 1 from public.payment_events where reservation_id = reserva_c and event_type = 'PAYMENT_HOLD_EXHAUSTED') then
    falhas := falhas || 'C3f: resposta definitiva não é incidente';
  end if;

  -- ========================================================================
  -- Cenário 4 — pagamento tardio sem capacidade
  -- ========================================================================
  -- session_a tem capacidade 1 e já está ocupada por reserva_b (CONFIRMED).
  criacao := public.create_pre_reservation(
    session_b, 'Cliente Selftest Quatro', '11144477735', '61999990000',
    'selftest-4@example.test', 1, '', gen_random_uuid()
  );
  reserva_a := (criacao ->> 'reservationId')::uuid;
  perform public.attach_payment_checkout(reserva_a, 'INFINITEPAY', 'slug-selftest-4', 'https://checkout.infinitepay.io/selftest4');
  update public.reservations
  set session_id = session_a, expires_at = now() - interval '4 hours',
      payment_hold_until = null, status = 'EXPIRED'
  where id = reserva_a;

  resultado := public.reconcile_reservation_payment(
    reserva_a, 'INFINITEPAY', 'tx-selftest-tardio',
    (select total_cents from public.reservations where id = reserva_a),
    'https://recibo.infinitepay.io/y', '{"stage":"selftest"}'::jsonb
  );
  if resultado <> 'NO_CAPACITY' then
    falhas := falhas || format('C4a: pagamento tardio sem vaga devia retornar NO_CAPACITY, retornou %s', resultado);
  end if;
  if not exists (
    select 1 from public.payment_events
    where reservation_id = reserva_a and event_type = 'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY'
  ) then
    falhas := falhas || 'C4b: o incidente precisa ficar gravado, nunca silenciado';
  end if;
  if (select status from public.reservations where id = reserva_b) <> 'CONFIRMED' then
    falhas := falhas || 'C4c: quem já estava confirmado não pode ser derrubado';
  end if;
  if public.payment_review_reason(reserva_a) <> 'APPROVED_NO_CAPACITY' then
    falhas := falhas || 'C4d: o incidente precisa aparecer na revisão administrativa';
  end if;

  -- ========================================================================
  -- Cenário 5 — pagamento tardio COM capacidade é recuperado
  -- ========================================================================
  criacao := public.create_pre_reservation(
    session_b, 'Cliente Selftest Cinco', '11144477735', '61999990000',
    'selftest-5@example.test', 1, '', gen_random_uuid()
  );
  reserva_c := (criacao ->> 'reservationId')::uuid;
  perform public.attach_payment_checkout(reserva_c, 'INFINITEPAY', 'slug-selftest-5', 'https://checkout.infinitepay.io/selftest5');
  update public.reservations
  set expires_at = now() - interval '4 hours', payment_hold_until = null, status = 'EXPIRED'
  where id = reserva_c;

  resultado := public.reconcile_reservation_payment(
    reserva_c, 'INFINITEPAY', 'tx-selftest-recupera',
    (select total_cents from public.reservations where id = reserva_c),
    'https://recibo.infinitepay.io/z', '{"stage":"selftest"}'::jsonb
  );
  if resultado <> 'RECONCILED' then
    falhas := falhas || format('C5a: pagamento tardio com vaga devia ser RECONCILED, retornou %s', resultado);
  end if;
  if (select status from public.reservations where id = reserva_c) <> 'CONFIRMED' then
    falhas := falhas || 'C5b: a reserva recuperada precisa ficar CONFIRMED';
  end if;
  if public.reservation_payment_status(reserva_c) <> 'PAID' then
    falhas := falhas || 'C5c: reserva recuperada não pode aparecer como não paga no painel';
  end if;

  -- ========================================================================
  -- Cenário 6 — a fila da reconciliação enxerga quem precisa ser conferido
  -- ========================================================================
  criacao := public.create_pre_reservation(
    session_b, 'Cliente Selftest Seis', '11144477735', '61999990000',
    'selftest-6@example.test', 1, '', gen_random_uuid()
  );
  reserva_a := (criacao ->> 'reservationId')::uuid;
  perform public.attach_payment_checkout(reserva_a, 'INFINITEPAY', 'slug-selftest-6', 'https://checkout.infinitepay.io/selftest6');
  update public.reservations set expires_at = now() + interval '3 minutes' where id = reserva_a;

  select count(*) into contagem
  from public.claim_payment_reconciliation(50, 5, 72) q
  where q.reservation_id = reserva_a;
  if contagem <> 1 then
    falhas := falhas || 'C6a: pré-reserva prestes a vencer precisa entrar na fila antes do prazo';
  end if;

  -- Reserva já confirmada nunca volta para a fila.
  select count(*) into contagem
  from public.claim_payment_reconciliation(50, 0, 72) q
  where q.reservation_id = reserva_b;
  if contagem <> 0 then
    falhas := falhas || 'C6b: reserva confirmada não pode voltar para a fila';
  end if;

  -- ========================================================================
  -- Cenário 7 — trilha durável aceita webhook sem reserva correspondente
  -- ========================================================================
  perform public.record_payment_step(
    'selftest', 'WEBHOOK', 'WEBHOOK_REJECTED', 'INVALID',
    'pedido-que-nao-existe', null, null, 400, 12, 'MISSING_ORDER_NSU', '{"body_format":"unparseable"}'::jsonb
  );
  if not exists (
    select 1 from public.payment_webhook_log
    where request_id = 'selftest' and reservation_id is null and step = 'WEBHOOK_REJECTED'
  ) then
    falhas := falhas || 'C7a: webhook órfão precisa deixar rastro no banco';
  end if;

  -- E aceita etapa ligada a uma reserva real.
  perform public.record_payment_step(
    'selftest', 'RECONCILIATION', 'RECONCILIATION_SUCCESS', 'OK',
    reserva_c::text, 'slug-selftest-5', 'tx-selftest-recupera', 200, 340, null, '{}'::jsonb
  );
  if not exists (
    select 1 from public.payment_webhook_log where request_id = 'selftest' and reservation_id = reserva_c
  ) then
    falhas := falhas || 'C7b: a trilha precisa ligar a etapa à reserva quando o order_nsu é válido';
  end if;

  -- ========================================================================
  -- Resultado
  -- ========================================================================
  if array_length(falhas, 1) is null then
    procedure_note := 'SELFTEST_OK — todos os cenários passaram. Transação abortada de propósito: nada foi persistido.';
  else
    procedure_note := 'SELFTEST_FALHOU: ' || array_to_string(falhas, ' | ');
  end if;

  raise exception '%', procedure_note;
end;
$$;
