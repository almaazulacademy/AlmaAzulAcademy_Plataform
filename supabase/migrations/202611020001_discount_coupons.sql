-- =============================================================================
-- Cupons de desconto — Fase 2: banco e regras de negócio
-- =============================================================================
--
-- Cupom percentual (1% a 99%) aplicado no servidor, na criação da pré-reserva.
-- Nada aqui é chamado pelo site ainda: o painel (fase 3) e o checkout (fases 4
-- e 5) chegam depois, atrás de COUPONS_ADMIN_ENABLED e COUPONS_CHECKOUT_ENABLED.
--
-- ## Onde o desconto mora
--
-- `reservations.total_cents` é, por invariante do banco, `quantity *
-- unit_price_cents` (coluna gerada no repositório; CHECK + gatilho no schema
-- legado de produção). Todo o resto — confirmação, reconciliação, painel,
-- receita, planilha — lê `total_cents` como "valor pago". Por isso a reserva com
-- cupom nasce com `unit_price_cents` **já descontado**, e o preço de lista, o
-- percentual e os valores ficam congelados em `coupon_redemptions`. Nenhum
-- caminho de pagamento muda: a InfinitePay recebe `quantity × unitário com
-- desconto`, exatamente o total que a confirmação exige.
--
-- ## Arredondamento
--
-- Por participante, meio centavo para cima:
--   unitário final = unitário − floor((unitário × % + 50) / 100)
-- R$ 70,00 com 10% → R$ 63,00; duas pessoas → R$ 126,00. O total é sempre
-- quantidade × unitário final, sem sobra de centavo entre o que se mostra, o que
-- se cobra e o que a confirmação compara.
--
-- ## Contagem de usos (1 uso = 1 reserva, qualquer que seja o número de pessoas)
--
-- Não há gatilho nem coluna de estado mantida à parte: o estado do uso é
-- deduzido da reserva, com a mesma régua da capacidade.
--
--   RESERVED                 pré-reserva ainda válida (inclui a janela de
--                            segurança do pagamento) — conta
--   CONFIRMED                pagamento confirmado (`confirmed_at`) — conta
--   CANCELLED_AFTER_PAYMENT  paga e depois cancelada — continua contando
--   RELEASED                 liberada pelo ADMIN, com justificativa — não conta
--   LAPSED                   expirou ou foi cancelada sem pagamento — não conta
--
-- Webhook repetido não muda nada (a reserva já está CONFIRMED). Pagamento tardio
-- reconciliado volta a contar sozinho, porque ganha `confirmed_at`.
--
-- ## Concorrência
--
-- `create_pre_reservation_with_coupon` trava a linha do cupom (`FOR UPDATE`)
-- antes de contar os usos e antes de `create_pre_reservation` travar a sessão.
-- Duas compras disputando o último uso são serializadas: a segunda conta o uso
-- da primeira e é recusada, sem criar reserva. Ordem de travas: cupom → sessão;
-- nenhum caminho trava sessão e depois cupom.
--
-- ## Pagamento tardio acima do limite
--
-- Uma pré-reserva que expira (e esgota a janela de segurança) libera o uso; se
-- outro cliente o ocupar e o primeiro pagamento for reconciliado depois, os
-- usos pagos passam do limite. O pagamento **não** é recusado — o dinheiro já
-- entrou pelo valor com desconto. O caso nunca é silencioso: o cupom traz
-- `overLimit = true` e `excessCount` (usos pagos além do limite) em qualquer
-- situação — ativo, inativo, expirado ou agendado —, cada uso pago além do
-- limite sai com `overLimit = true` no detalhe, e
-- `supabase/diagnostics/discount_coupons_report.sql` mostra os excedentes.
--
-- ## O que não muda
--
-- `create_pre_reservation`, confirmação, reconciliação, expiração, webhook,
-- check-in, planilha e lista de espera ficam intactos. Reserva sem cupom segue
-- exatamente o caminho de hoje. A única função existente reescrita é
-- `reservation_standby_target_rejection` (Stand-by), para comparar o preço da
-- turma com o preço de lista da reserva — não com o unitário descontado.
--
-- ## Valor mínimo de cobrança
--
-- `coupon_settings.min_charge_cents` nasce nulo: enquanto o mínimo da
-- InfinitePay não for confirmado, nenhum cupom é aplicado
-- (`COUPON_UNAVAILABLE`). Nada aqui presume um valor.

-- -----------------------------------------------------------------------------
-- 1. Tabelas
-- -----------------------------------------------------------------------------

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  percent_off integer not null,
  valid_from date,
  valid_until date,
  max_uses integer,
  scope text not null default 'ALL_REGULAR',
  status text not null default 'INACTIVE',
  description text,
  -- Autoria sem chave estrangeira para auth.users, de propósito: a chave faria a
  -- migration e o rollback travarem a tabela de login. O ator já é conferido
  -- (`is_active_owner_admin`) e fica também em admin_audit_log.
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Só maiúsculas: a unicidade do código já é sem diferença de caixa.
  constraint coupons_code_format check (code ~ '^[A-Z0-9-]{3,32}$' and code ~ '[A-Z0-9]'),
  constraint coupons_percent_range check (percent_off between 1 and 99),
  constraint coupons_validity_order check (valid_from is null or valid_until is null or valid_until >= valid_from),
  constraint coupons_max_uses_positive check (max_uses is null or max_uses >= 1),
  constraint coupons_scope_check check (scope in ('ALL_REGULAR', 'SELECTED')),
  constraint coupons_status_check check (status in ('ACTIVE', 'INACTIVE')),
  constraint coupons_description_length check (description is null or char_length(description) between 1 and 500)
);

create unique index if not exists coupons_code_key on public.coupons (code);

-- Experiências de um cupom `SELECTED`. Evento especial só aceita cupom quando
-- aparece aqui; `ALL_REGULAR` nunca alcança um evento.
create table if not exists public.coupon_experiences (
  coupon_id uuid not null references public.coupons(id) on delete restrict,
  experience_id uuid not null references public.experiences(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (coupon_id, experience_id)
);

create index if not exists coupon_experiences_experience_idx on public.coupon_experiences (experience_id);

-- Um uso por reserva, com os valores congelados no momento da compra. Alterar
-- ou desativar o cupom depois não mexe em nada daqui.
create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete restrict,
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  code text not null,
  percent_off integer not null,
  quantity integer not null,
  original_unit_price_cents integer not null,
  unit_price_cents integer not null,
  original_total_cents integer not null,
  discount_cents integer not null,
  total_cents integer not null,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid,
  released_reason text,
  constraint coupon_redemptions_reservation_key unique (reservation_id),
  constraint coupon_redemptions_percent_range check (percent_off between 1 and 99),
  constraint coupon_redemptions_quantity_positive check (quantity >= 1),
  constraint coupon_redemptions_unit_prices check (original_unit_price_cents >= 1 and unit_price_cents between 1 and original_unit_price_cents),
  constraint coupon_redemptions_totals check (
    original_total_cents = quantity * original_unit_price_cents
    and total_cents = quantity * unit_price_cents
    and discount_cents = original_total_cents - total_cents
    and discount_cents >= 0
  ),
  constraint coupon_redemptions_release check (
    (released_at is null and released_reason is null)
    or (released_at is not null and char_length(btrim(released_reason)) >= 3)
  )
);

create index if not exists coupon_redemptions_coupon_idx on public.coupon_redemptions (coupon_id, created_at);

-- Interruptor único do valor mínimo. Nulo = mínimo da InfinitePay ainda não
-- confirmado = nenhum cupom é aplicado.
create table if not exists public.coupon_settings (
  singleton boolean primary key default true check (singleton),
  min_charge_cents integer,
  updated_at timestamptz not null default now(),
  constraint coupon_settings_min_charge_positive check (min_charge_cents is null or min_charge_cents >= 1)
);

insert into public.coupon_settings (singleton) values (true) on conflict (singleton) do nothing;

-- Sem leitura direta por ninguém: tudo passa pelas RPCs abaixo.
alter table public.coupons enable row level security;
alter table public.coupon_experiences enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.coupon_settings enable row level security;

revoke all on public.coupons from public, anon, authenticated, service_role;
revoke all on public.coupon_experiences from public, anon, authenticated, service_role;
revoke all on public.coupon_redemptions from public, anon, authenticated, service_role;
revoke all on public.coupon_settings from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Histórico financeiro imutável
-- -----------------------------------------------------------------------------
--
-- Os valores de um uso nunca mudam e nenhum uso é apagado. Só a liberação
-- manual pode ser gravada, uma vez.
create or replace function public.enforce_coupon_redemption_history()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'COUPON_REDEMPTION_IMMUTABLE' using errcode = '42501';
  end if;
  if new.coupon_id <> old.coupon_id
     or new.reservation_id <> old.reservation_id
     or new.code <> old.code
     or new.percent_off <> old.percent_off
     or new.quantity <> old.quantity
     or new.original_unit_price_cents <> old.original_unit_price_cents
     or new.unit_price_cents <> old.unit_price_cents
     or new.original_total_cents <> old.original_total_cents
     or new.discount_cents <> old.discount_cents
     or new.total_cents <> old.total_cents
     or new.created_at <> old.created_at
     or (old.released_at is not null and (
           new.released_at is distinct from old.released_at
           or new.released_by is distinct from old.released_by
           or new.released_reason is distinct from old.released_reason)) then
    raise exception 'COUPON_REDEMPTION_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists coupon_redemptions_history_guard on public.coupon_redemptions;
create trigger coupon_redemptions_history_guard
  before update or delete on public.coupon_redemptions
  for each row execute function public.enforce_coupon_redemption_history();

-- -----------------------------------------------------------------------------
-- 3. Regras internas
-- -----------------------------------------------------------------------------

-- Código como o cliente digitou → código como é guardado.
create or replace function public.coupon_normalize_code(p_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select upper(btrim(coalesce(p_code, ''), E' \t\r\n'))
$$;

-- "Hoje" no horário de Brasília: a validade vale pela data da compra.
create or replace function public.coupon_today()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'America/Sao_Paulo')::date
$$;

-- Unitário com desconto, meio centavo para cima. Espelho de `lib/coupons`.
create or replace function public.coupon_discounted_unit_cents(p_unit_cents integer, p_percent_off integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select (p_unit_cents - (p_unit_cents::bigint * p_percent_off + 50) / 100)::integer
$$;

-- Estado de um uso, deduzido da reserva. Ver o cabeçalho.
create or replace function public.coupon_redemption_state(
  p_released_at timestamptz,
  p_reservation_status text,
  p_confirmed_at timestamptz,
  p_expires_at timestamptz
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_released_at is not null then 'RELEASED'
    when p_confirmed_at is not null or p_reservation_status in ('CONFIRMED', 'AWAITING_RESCHEDULE') then
      case when p_reservation_status = 'CANCELLED' then 'CANCELLED_AFTER_PAYMENT' else 'CONFIRMED' end
    when p_reservation_status = 'PRE_RESERVED' and p_expires_at > now() then 'RESERVED'
    else 'LAPSED'
  end
$$;

-- Usos que ocupam o limite: reservados, pagos e pagos depois cancelados.
create or replace function public.coupon_uses(p_coupon_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.coupon_redemptions cr
  join public.reservations r on r.id = cr.reservation_id
  where cr.coupon_id = p_coupon_id
    and public.coupon_redemption_state(cr.released_at, r.status::text, r.confirmed_at, r.expires_at)
        in ('RESERVED', 'CONFIRMED', 'CANCELLED_AFTER_PAYMENT')
$$;

-- O cupom vale para esta experiência agora? Null = sim; senão, o motivo.
create or replace function public.coupon_rejection(p_coupon_id uuid, p_experience_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target public.coupons%rowtype;
  experience_kind text;
  today date := public.coupon_today();
begin
  select * into target from public.coupons where id = p_coupon_id;
  if not found then return 'COUPON_NOT_FOUND'; end if;
  if target.status <> 'ACTIVE' then return 'COUPON_INACTIVE'; end if;
  if target.valid_until is not null and today > target.valid_until then return 'COUPON_EXPIRED'; end if;
  if target.valid_from is not null and today < target.valid_from then return 'COUPON_NOT_STARTED'; end if;

  select e.kind into experience_kind from public.experiences e where e.id = p_experience_id;
  if not found then return 'COUPON_NOT_ELIGIBLE'; end if;
  if target.scope = 'ALL_REGULAR' then
    if experience_kind = 'EVENT' then return 'COUPON_NOT_ELIGIBLE'; end if;
  elsif not exists (
    select 1 from public.coupon_experiences ce
    where ce.coupon_id = target.id and ce.experience_id = p_experience_id
  ) then
    return 'COUPON_NOT_ELIGIBLE';
  end if;

  if target.max_uses is not null and public.coupon_uses(target.id) >= target.max_uses then
    return 'COUPON_EXHAUSTED';
  end if;
  return null;
end;
$$;

-- O valor com desconto pode ser cobrado? Null = sim; senão, o motivo.
create or replace function public.coupon_price_rejection(p_unit_cents integer, p_percent_off integer, p_quantity integer)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  minimum integer;
  final_unit integer;
begin
  select s.min_charge_cents into minimum from public.coupon_settings s where s.singleton;
  if minimum is null then return 'COUPON_UNAVAILABLE'; end if;
  if p_unit_cents is null or p_unit_cents < 1 then return 'COUPON_NOT_ELIGIBLE'; end if;
  final_unit := public.coupon_discounted_unit_cents(p_unit_cents, p_percent_off);
  if final_unit < 1 or final_unit::bigint * p_quantity < minimum then return 'COUPON_BELOW_MIN_CHARGE'; end if;
  return null;
end;
$$;

-- O cupom de uma reserva, como foi gravado. Null quando a reserva não tem cupom.
create or replace function public.coupon_reservation_summary(p_reservation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'code', cr.code,
    'percentOff', cr.percent_off,
    'quantity', cr.quantity,
    'originalUnitPriceCents', cr.original_unit_price_cents,
    'unitPriceCents', cr.unit_price_cents,
    'originalTotalCents', cr.original_total_cents,
    'discountCents', cr.discount_cents,
    'totalCents', cr.total_cents
  )
  from public.coupon_redemptions cr
  where cr.reservation_id = p_reservation_id
$$;

-- -----------------------------------------------------------------------------
-- 4. Checkout: prévia, visibilidade do campo e pré-reserva com cupom
-- -----------------------------------------------------------------------------

-- Prévia do desconto. Só leitura: não reserva uso nem vaga. A pré-reserva
-- valida tudo de novo, com o cupom travado.
create or replace function public.preview_coupon(p_session_id uuid, p_quantity integer, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized text := public.coupon_normalize_code(p_code);
  target_session public.sessions%rowtype;
  target public.coupons%rowtype;
  reason text;
  final_unit integer;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'INVALID_QUANTITY' using errcode = '22023';
  end if;

  select * into target_session from public.sessions where id = p_session_id;
  if not found or target_session.status <> 'OPEN' or target_session.starts_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'SESSION_UNAVAILABLE');
  end if;
  if (select s.min_charge_cents from public.coupon_settings s where s.singleton) is null then
    return jsonb_build_object('ok', false, 'reason', 'COUPON_UNAVAILABLE');
  end if;

  select * into target from public.coupons where code = normalized;
  if not found then return jsonb_build_object('ok', false, 'reason', 'COUPON_NOT_FOUND'); end if;

  reason := public.coupon_rejection(target.id, target_session.experience_id);
  if reason is null then
    reason := public.coupon_price_rejection(target_session.price_cents, target.percent_off, p_quantity);
  end if;
  if reason is not null then return jsonb_build_object('ok', false, 'reason', reason); end if;

  final_unit := public.coupon_discounted_unit_cents(target_session.price_cents, target.percent_off);
  return jsonb_build_object(
    'ok', true,
    'code', target.code,
    'percentOff', target.percent_off,
    'quantity', p_quantity,
    'originalUnitPriceCents', target_session.price_cents,
    'unitPriceCents', final_unit,
    'originalTotalCents', target_session.price_cents * p_quantity,
    'discountCents', (target_session.price_cents - final_unit) * p_quantity,
    'totalCents', final_unit * p_quantity
  );
end;
$$;

-- O campo "Tem um cupom?" aparece nesta sessão? Experiência regular: sempre.
-- Evento especial: só quando algum cupom ativo e não vencido o seleciona.
create or replace function public.coupon_field_visible(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
      when e.kind = 'EVENT' then exists (
        select 1
        from public.coupon_experiences ce
        join public.coupons c on c.id = ce.coupon_id
        where ce.experience_id = e.id
          and c.status = 'ACTIVE'
          and (c.valid_until is null or c.valid_until >= public.coupon_today())
      )
      else true
    end
    from public.sessions s
    join public.experiences e on e.id = s.experience_id
    where s.id = p_session_id
  ), false)
$$;

-- Pré-reserva com cupom. Envolve `create_pre_reservation`, que não muda: tudo
-- numa transação só. Qualquer recusa do cupom desfaz a pré-reserva inteira —
-- nenhuma vaga nem uso fica preso, e a chave de idempotência continua livre.
--
-- Repetição da mesma chave devolve a reserva como foi gravada, com o cupom que
-- ela tiver (ou nenhum), sem aplicar desconto de novo.
create or replace function public.create_pre_reservation_with_coupon(
  p_session_id uuid,
  p_full_name text,
  p_cpf text,
  p_phone text,
  p_email text,
  p_quantity integer,
  p_notes text,
  p_idempotency_key uuid,
  p_coupon_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  normalized text := public.coupon_normalize_code(p_coupon_code);
  target public.coupons%rowtype;
  session_experience uuid;
  created jsonb;
  created_id uuid;
  created_here boolean;
  booked public.reservations%rowtype;
  reason text;
  final_unit integer;
begin
  if exists (select 1 from public.reservations where idempotency_key = p_idempotency_key) then
    created := public.create_pre_reservation(p_session_id, p_full_name, p_cpf, p_phone, p_email, p_quantity, p_notes, p_idempotency_key);
    return created || jsonb_build_object('coupon', public.coupon_reservation_summary((created ->> 'reservationId')::uuid));
  end if;

  if (select s.min_charge_cents from public.coupon_settings s where s.singleton) is null then
    raise exception using message = 'COUPON_UNAVAILABLE', errcode = 'P0001';
  end if;

  -- A trava do cupom serializa quem disputa o último uso.
  select * into target from public.coupons where code = normalized for update;
  if not found then raise exception using message = 'COUPON_NOT_FOUND', errcode = 'P0001'; end if;

  -- Outra tentativa com a mesma chave pode ter terminado enquanto esperávamos.
  if exists (select 1 from public.reservations where idempotency_key = p_idempotency_key) then
    created := public.create_pre_reservation(p_session_id, p_full_name, p_cpf, p_phone, p_email, p_quantity, p_notes, p_idempotency_key);
    return created || jsonb_build_object('coupon', public.coupon_reservation_summary((created ->> 'reservationId')::uuid));
  end if;

  select s.experience_id into session_experience from public.sessions s where s.id = p_session_id;
  if not found then raise exception using message = 'SESSION_UNAVAILABLE', errcode = 'P0001'; end if;

  reason := public.coupon_rejection(target.id, session_experience);
  if reason is not null then raise exception using message = reason, errcode = 'P0001'; end if;

  created := public.create_pre_reservation(p_session_id, p_full_name, p_cpf, p_phone, p_email, p_quantity, p_notes, p_idempotency_key);
  created_id := (created ->> 'reservationId')::uuid;

  -- Uma tentativa sem cupom com a mesma chave, concorrente, pode ter gravado a
  -- reserva primeiro: ela não é desta transação e fica como está.
  select r.xmin::text::bigint = txid_current() % 4294967296 into created_here
  from public.reservations r where r.id = created_id;
  if not coalesce(created_here, false) then
    return created || jsonb_build_object('coupon', public.coupon_reservation_summary(created_id));
  end if;

  select * into booked from public.reservations where id = created_id;
  reason := public.coupon_price_rejection(booked.unit_price_cents, target.percent_off, booked.quantity);
  if reason is not null then raise exception using message = reason, errcode = 'P0001'; end if;

  final_unit := public.coupon_discounted_unit_cents(booked.unit_price_cents, target.percent_off);
  update public.reservations set unit_price_cents = final_unit, updated_at = now() where id = booked.id;

  insert into public.coupon_redemptions (
    coupon_id, reservation_id, code, percent_off, quantity,
    original_unit_price_cents, unit_price_cents, original_total_cents, discount_cents, total_cents
  ) values (
    target.id, booked.id, target.code, target.percent_off, booked.quantity,
    booked.unit_price_cents, final_unit, booked.quantity * booked.unit_price_cents,
    booked.quantity * (booked.unit_price_cents - final_unit), booked.quantity * final_unit
  );

  return created || jsonb_build_object(
    'totalCents', (select r.total_cents from public.reservations r where r.id = booked.id),
    'coupon', public.coupon_reservation_summary(booked.id)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Painel: consulta (ADMIN e OPERATOR) e gestão (só ADMIN)
-- -----------------------------------------------------------------------------

-- Erro de entrada do formulário do painel, ou null.
create or replace function public.coupon_admin_input_error(
  p_code text,
  p_percent_off integer,
  p_valid_from date,
  p_valid_until date,
  p_max_uses integer,
  p_scope text,
  p_experience_ids uuid[],
  p_description text
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ids uuid[] := coalesce(p_experience_ids, '{}'::uuid[]);
  distinct_ids integer;
begin
  if public.coupon_normalize_code(p_code) !~ '^[A-Z0-9-]{3,32}$' or public.coupon_normalize_code(p_code) !~ '[A-Z0-9]' then
    return 'COUPON_INVALID_CODE';
  end if;
  if p_percent_off is null or p_percent_off < 1 or p_percent_off > 99 then return 'COUPON_INVALID_PERCENT'; end if;
  if p_valid_from is not null and p_valid_until is not null and p_valid_until < p_valid_from then return 'COUPON_INVALID_VALIDITY'; end if;
  if p_max_uses is not null and p_max_uses < 1 then return 'COUPON_INVALID_LIMIT'; end if;
  if p_scope is null or p_scope not in ('ALL_REGULAR', 'SELECTED') then return 'COUPON_INVALID_SCOPE'; end if;
  select count(distinct id) into distinct_ids from unnest(ids) as id;
  if p_scope = 'ALL_REGULAR' and distinct_ids > 0 then return 'COUPON_INVALID_EXPERIENCES'; end if;
  if p_scope = 'SELECTED' and (
       distinct_ids = 0
       or distinct_ids <> (select count(*) from public.experiences e where e.id = any(ids))
     ) then
    return 'COUPON_INVALID_EXPERIENCES';
  end if;
  if p_description is not null and char_length(btrim(p_description)) > 500 then return 'COUPON_INVALID_DESCRIPTION'; end if;
  return null;
end;
$$;

-- Um cupom como o painel o vê: dados, experiências, usos e situação.
--
-- `state` é só a situação operacional: INACTIVE, EXPIRED, SCHEDULED, EXHAUSTED
-- (sem uso livre) ou ACTIVE. O excesso de limite é um alerta à parte, que não
-- depende dela: `excessCount` = usos pagos (confirmados ou pagos e depois
-- cancelados) além de `maxUses`, e `overLimit` = `excessCount > 0`. É o mesmo
-- número de usos com `overLimit` no detalhe e a coluna `excedentes` do
-- relatório. Nada disso muda quem pode usar o cupom: isso é `coupon_rejection`.
create or replace function public.admin_coupon_json(p_coupon_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with target as (select * from public.coupons where id = p_coupon_id),
  usage as (
    select
      count(*) filter (where state = 'RESERVED')::integer as reserved,
      count(*) filter (where state = 'CONFIRMED')::integer as confirmed,
      count(*) filter (where state = 'CANCELLED_AFTER_PAYMENT')::integer as cancelled_after_payment,
      count(*) filter (where state = 'RELEASED')::integer as released,
      count(*) filter (where state = 'LAPSED')::integer as lapsed,
      count(*)::integer as redemptions
    from (
      select public.coupon_redemption_state(cr.released_at, r.status::text, r.confirmed_at, r.expires_at) as state
      from public.coupon_redemptions cr join public.reservations r on r.id = cr.reservation_id
      where cr.coupon_id = p_coupon_id
    ) states
  )
  select jsonb_build_object(
    'id', t.id,
    'code', t.code,
    'percentOff', t.percent_off,
    'validFrom', t.valid_from,
    'validUntil', t.valid_until,
    'maxUses', t.max_uses,
    'scope', t.scope,
    'status', t.status,
    'description', t.description,
    'experiences', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'slug', e.slug, 'kind', e.kind) order by e.title)
      from public.coupon_experiences ce join public.experiences e on e.id = ce.experience_id
      where ce.coupon_id = t.id
    ), '[]'::jsonb),
    'uses', jsonb_build_object(
      'counted', u.reserved + u.confirmed + u.cancelled_after_payment,
      'reserved', u.reserved,
      'confirmed', u.confirmed,
      'cancelledAfterPayment', u.cancelled_after_payment,
      'released', u.released,
      'lapsed', u.lapsed
    ),
    -- Código, percentual e aplicabilidade travam no primeiro uso, qualquer que seja.
    'locked', u.redemptions > 0,
    'state', case
      when t.status = 'INACTIVE' then 'INACTIVE'
      when t.valid_until is not null and public.coupon_today() > t.valid_until then 'EXPIRED'
      when t.valid_from is not null and public.coupon_today() < t.valid_from then 'SCHEDULED'
      when t.max_uses is not null and u.reserved + u.confirmed + u.cancelled_after_payment >= t.max_uses then 'EXHAUSTED'
      else 'ACTIVE'
    end,
    'overLimit', t.max_uses is not null and u.confirmed + u.cancelled_after_payment > t.max_uses,
    'excessCount', case when t.max_uses is null then 0 else greatest(u.confirmed + u.cancelled_after_payment - t.max_uses, 0) end,
    'createdAt', t.created_at,
    'updatedAt', t.updated_at
  )
  from target t cross join usage u
$$;

create or replace function public.admin_list_coupons(p_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(public.admin_coupon_json(c.id) order by c.created_at desc, c.code)
    from public.coupons c
  ), '[]'::jsonb);
end;
$$;

-- Detalhe com cada uso. `overLimit`: uso pago além do limite, contado na ordem
-- de confirmação — o pagamento tardio que a operação precisa enxergar.
create or replace function public.admin_get_coupon(p_actor_id uuid, p_coupon_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  limit_uses integer;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  select c.max_uses into limit_uses from public.coupons c where c.id = p_coupon_id;
  if not found then return null; end if;

  return public.admin_coupon_json(p_coupon_id) || jsonb_build_object('redemptions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', x.id,
      'reservationId', x.reservation_id,
      'publicCode', x.public_code,
      'experienceTitle', x.experience_title,
      'startsAt', x.starts_at,
      'reservationStatus', x.reservation_status,
      'state', x.state,
      'quantity', x.quantity,
      'percentOff', x.percent_off,
      'originalTotalCents', x.original_total_cents,
      'discountCents', x.discount_cents,
      'totalCents', x.total_cents,
      'createdAt', x.created_at,
      'confirmedAt', x.confirmed_at,
      'releasedAt', x.released_at,
      'releasedReason', x.released_reason,
      'releasedByName', x.released_by_name,
      'overLimit', limit_uses is not null and x.paid_rank is not null and x.paid_rank > limit_uses
    ) order by x.created_at desc)
    from (
      select s.*,
             case when s.state in ('CONFIRMED', 'CANCELLED_AFTER_PAYMENT')
                  then row_number() over (partition by s.state in ('CONFIRMED', 'CANCELLED_AFTER_PAYMENT') order by s.confirmed_at nulls last, s.created_at, s.id)
             end as paid_rank
      from (
        select cr.id, cr.reservation_id, r.public_code, e.title as experience_title, se.starts_at,
               r.status::text as reservation_status,
               public.coupon_redemption_state(cr.released_at, r.status::text, r.confirmed_at, r.expires_at) as state,
               cr.quantity, cr.percent_off, cr.original_total_cents, cr.discount_cents, cr.total_cents,
               cr.created_at, r.confirmed_at, cr.released_at, cr.released_reason,
               au.display_name as released_by_name
        from public.coupon_redemptions cr
        join public.reservations r on r.id = cr.reservation_id
        join public.sessions se on se.id = r.session_id
        join public.experiences e on e.id = r.experience_id
        left join public.admin_users au on au.user_id = cr.released_by
        where cr.coupon_id = p_coupon_id
      ) s
    ) x
  ), '[]'::jsonb));
end;
$$;

create or replace function public.admin_create_coupon(
  p_actor_id uuid,
  p_code text,
  p_percent_off integer,
  p_valid_from date,
  p_valid_until date,
  p_max_uses integer,
  p_scope text,
  p_experience_ids uuid[],
  p_status text,
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized text := public.coupon_normalize_code(p_code);
  input_error text;
  created_id uuid;
begin
  if not public.is_active_owner_admin(p_actor_id) then
    raise exception 'COUPON_ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  input_error := public.coupon_admin_input_error(p_code, p_percent_off, p_valid_from, p_valid_until, p_max_uses, p_scope, p_experience_ids, p_description);
  if input_error is not null then raise exception using message = input_error, errcode = '22023'; end if;
  if p_status is null or p_status not in ('ACTIVE', 'INACTIVE') then
    raise exception 'COUPON_INVALID_STATUS' using errcode = '22023';
  end if;
  if exists (select 1 from public.coupons where code = normalized) then
    raise exception 'COUPON_CODE_TAKEN' using errcode = '23505';
  end if;

  insert into public.coupons (code, percent_off, valid_from, valid_until, max_uses, scope, status, description, created_by, updated_by)
  values (normalized, p_percent_off, p_valid_from, p_valid_until, p_max_uses, p_scope, p_status,
          nullif(btrim(coalesce(p_description, '')), ''), p_actor_id, p_actor_id)
  returning id into created_id;

  if p_scope = 'SELECTED' then
    insert into public.coupon_experiences (coupon_id, experience_id)
    select created_id, id from (select distinct unnest(p_experience_ids) as id) ids;
  end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'COUPON_CREATED', 'COUPON', created_id, jsonb_build_object('coupon', public.admin_coupon_json(created_id) - 'uses' - 'state' - 'locked' - 'overLimit' - 'excessCount'));

  return public.admin_coupon_json(created_id);
end;
$$;

-- Edição. Depois do primeiro uso, código, percentual e aplicabilidade ficam
-- como estão; o limite nunca é reduzido abaixo dos usos que já contam.
create or replace function public.admin_update_coupon(
  p_actor_id uuid,
  p_coupon_id uuid,
  p_code text,
  p_percent_off integer,
  p_valid_from date,
  p_valid_until date,
  p_max_uses integer,
  p_scope text,
  p_experience_ids uuid[],
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized text := public.coupon_normalize_code(p_code);
  target public.coupons%rowtype;
  input_error text;
  current_ids uuid[];
  requested_ids uuid[];
  before_json jsonb;
  locked boolean;
begin
  if not public.is_active_owner_admin(p_actor_id) then
    raise exception 'COUPON_ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  select * into target from public.coupons where id = p_coupon_id for update;
  if not found then raise exception 'COUPON_NOT_FOUND' using errcode = 'P0002'; end if;

  input_error := public.coupon_admin_input_error(p_code, p_percent_off, p_valid_from, p_valid_until, p_max_uses, p_scope, p_experience_ids, p_description);
  if input_error is not null then raise exception using message = input_error, errcode = '22023'; end if;

  select coalesce(array_agg(experience_id order by experience_id), '{}') into current_ids
  from public.coupon_experiences where coupon_id = target.id;
  select coalesce(array_agg(id order by id), '{}') into requested_ids
  from (select distinct unnest(coalesce(p_experience_ids, '{}'::uuid[])) as id) ids;

  locked := exists (select 1 from public.coupon_redemptions where coupon_id = target.id);
  if locked and (normalized <> target.code or p_percent_off <> target.percent_off or p_scope <> target.scope or requested_ids <> current_ids) then
    raise exception 'COUPON_LOCKED_FIELDS' using errcode = '22023';
  end if;
  if normalized <> target.code and exists (select 1 from public.coupons where code = normalized and id <> target.id) then
    raise exception 'COUPON_CODE_TAKEN' using errcode = '23505';
  end if;
  -- Reduzir o limite abaixo dos usos que já contam é recusado. Manter (ou subir)
  -- um limite que um pagamento tardio já ultrapassou não é: senão um cupom em
  -- excesso nunca mais poderia ter data ou descrição editadas.
  if p_max_uses is not null
     and p_max_uses < public.coupon_uses(target.id)
     and (target.max_uses is null or p_max_uses < target.max_uses) then
    raise exception 'COUPON_LIMIT_BELOW_USAGE' using errcode = '22023';
  end if;

  before_json := public.admin_coupon_json(target.id) - 'uses' - 'state' - 'locked' - 'overLimit' - 'excessCount';

  update public.coupons
  set code = normalized,
      percent_off = p_percent_off,
      valid_from = p_valid_from,
      valid_until = p_valid_until,
      max_uses = p_max_uses,
      scope = p_scope,
      description = nullif(btrim(coalesce(p_description, '')), ''),
      updated_by = p_actor_id,
      updated_at = now()
  where id = target.id;

  if requested_ids <> current_ids then
    delete from public.coupon_experiences where coupon_id = target.id;
    insert into public.coupon_experiences (coupon_id, experience_id)
    select target.id, unnest(requested_ids);
  end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'COUPON_UPDATED', 'COUPON', target.id, jsonb_build_object(
    'before', before_json,
    'after', public.admin_coupon_json(target.id) - 'uses' - 'state' - 'locked' - 'overLimit' - 'excessCount'
  ));

  return public.admin_coupon_json(target.id);
end;
$$;

-- Ativar ou desativar. Desativar não mexe em reserva nenhuma: quem já tem a
-- pré-reserva paga o valor com desconto que foi gravado.
create or replace function public.admin_set_coupon_status(p_actor_id uuid, p_coupon_id uuid, p_status text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.coupons%rowtype;
begin
  if not public.is_active_owner_admin(p_actor_id) then
    raise exception 'COUPON_ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('ACTIVE', 'INACTIVE') then
    raise exception 'COUPON_INVALID_STATUS' using errcode = '22023';
  end if;
  select * into target from public.coupons where id = p_coupon_id for update;
  if not found then raise exception 'COUPON_NOT_FOUND' using errcode = 'P0002'; end if;
  if target.status = p_status then return public.admin_coupon_json(target.id); end if;

  update public.coupons set status = p_status, updated_by = p_actor_id, updated_at = now() where id = target.id;
  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, reason, metadata)
  values (
    p_actor_id,
    case when p_status = 'ACTIVE' then 'COUPON_ACTIVATED' else 'COUPON_DEACTIVATED' end,
    'COUPON', target.id,
    nullif(btrim(coalesce(p_reason, '')), ''),
    jsonb_build_object('code', target.code, 'previous_status', target.status)
  );
  return public.admin_coupon_json(target.id);
end;
$$;

-- Liberação manual de um uso pago e depois cancelado (cancelamento ou
-- reembolso). Só ADMIN, com justificativa. Nenhum outro estado é liberável: um
-- uso reservado ou confirmado ainda pode virar dinheiro pelo valor com desconto.
create or replace function public.admin_release_coupon_redemption(p_actor_id uuid, p_redemption_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  redemption public.coupon_redemptions%rowtype;
  booked public.reservations%rowtype;
  state text;
begin
  if not public.is_active_owner_admin(p_actor_id) then
    raise exception 'COUPON_ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;

  select * into redemption from public.coupon_redemptions where id = p_redemption_id;
  if not found then raise exception 'COUPON_REDEMPTION_NOT_FOUND' using errcode = 'P0002'; end if;
  -- Mesma ordem de travas da pré-reserva: cupom primeiro.
  perform 1 from public.coupons where id = redemption.coupon_id for update;
  select * into redemption from public.coupon_redemptions where id = p_redemption_id for update;
  select * into booked from public.reservations where id = redemption.reservation_id;

  state := public.coupon_redemption_state(redemption.released_at, booked.status::text, booked.confirmed_at, booked.expires_at);
  if state = 'RELEASED' then
    return jsonb_build_object('redemptionId', redemption.id, 'state', state, 'replayed', true);
  end if;
  if state <> 'CANCELLED_AFTER_PAYMENT' then
    raise exception 'COUPON_RELEASE_NOT_ALLOWED' using errcode = '22023';
  end if;

  update public.coupon_redemptions
  set released_at = now(), released_by = p_actor_id, released_reason = btrim(p_reason)
  where id = redemption.id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, reason, metadata)
  values (p_actor_id, 'COUPON_REDEMPTION_RELEASED', 'COUPON', redemption.coupon_id, btrim(p_reason), jsonb_build_object(
    'redemption_id', redemption.id,
    'reservation_id', redemption.reservation_id,
    'public_code', booked.public_code,
    'code', redemption.code
  ));

  return jsonb_build_object('redemptionId', redemption.id, 'state', 'RELEASED', 'replayed', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Stand-by: o preço da turma é comparado com o preço de lista da reserva
-- -----------------------------------------------------------------------------
--
-- Mesma função de 202610130002_reservation_standby.sql, com uma única mudança
-- na regra de preço do modo CUSTOMER (usado também pelo painel): numa reserva
-- com cupom, `unit_price_cents` é o valor com desconto, e a turma de destino
-- precisa ter o preço de lista que a reserva tinha. Reserva sem cupom compara
-- exatamente como antes. O desconto é preservado e nada é cobrado de novo — o
-- reagendamento não escreve em `unit_price_cents`.

-- A régua única de "esta turma pode receber esta reserva", fora a capacidade.
-- Usada tanto para montar a lista oferecida ao cliente quanto para decidir,
-- com a sessão travada, se o reagendamento acontece — a lista e a decisão não
-- têm como divergir.
--
--   ADMIN    — a mesma regra do reagendamento administrativo tradicional:
--              sessão aberta e futura; experiência publicada, ou a própria
--              experiência da reserva. Sem regra de preço.
--   RESTORE  — igual a ADMIN. O destino é sempre a turma original.
--   CUSTOMER — sessão aberta e futura, experiência publicada, base em operação
--              e **preço por participante igual ao preço de lista pago** (sem
--              o desconto de cupom, quando houver). Sem antecedência mínima.
--
-- Devolve null quando a turma é elegível, ou o símbolo da recusa.
create or replace function public.reservation_standby_target_rejection(
  p_reservation_id uuid,
  p_session_id uuid,
  p_mode text
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target public.reservations%rowtype;
  candidate public.sessions%rowtype;
  candidate_experience public.experiences%rowtype;
  base_status text;
begin
  if p_mode is null or p_mode not in ('ADMIN', 'CUSTOMER', 'RESTORE') then
    raise exception 'STANDBY_INVALID_MODE' using errcode = '22023';
  end if;

  select * into target from public.reservations where id = p_reservation_id;
  if not found then return 'RESERVATION_NOT_FOUND'; end if;

  select * into candidate from public.sessions where id = p_session_id;
  if not found then return 'SESSION_NOT_FOUND'; end if;

  select * into candidate_experience from public.experiences where id = candidate.experience_id;
  if not found then return 'EXPERIENCE_NOT_FOUND'; end if;

  if p_mode = 'CUSTOMER' then
    if candidate_experience.status <> 'PUBLISHED' then return 'EXPERIENCE_NOT_AVAILABLE'; end if;
    select b.status into base_status from public.bases b where b.id = candidate_experience.base_id;
    if base_status is distinct from 'ACTIVE' then return 'BASE_NOT_AVAILABLE'; end if;
  elsif candidate_experience.status <> 'PUBLISHED' and candidate_experience.id <> target.experience_id then
    return 'EXPERIENCE_NOT_AVAILABLE';
  end if;

  if candidate.status <> 'OPEN' then return 'SESSION_NOT_OPEN'; end if;
  if candidate.starts_at <= now() then return 'SESSION_MUST_BE_FUTURE'; end if;

  if p_mode = 'CUSTOMER' and candidate.price_cents <> coalesce(
    (select cr.original_unit_price_cents from public.coupon_redemptions cr where cr.reservation_id = target.id),
    target.unit_price_cents
  ) then
    return 'PRICE_NOT_ELIGIBLE';
  end if;

  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Permissões
-- -----------------------------------------------------------------------------

-- Internas: ninguém executa diretamente; as RPCs `security definer` as alcançam
-- como proprietário.
revoke all on function public.enforce_coupon_redemption_history() from public, anon, authenticated, service_role;
revoke all on function public.coupon_normalize_code(text) from public, anon, authenticated, service_role;
revoke all on function public.coupon_today() from public, anon, authenticated, service_role;
revoke all on function public.coupon_discounted_unit_cents(integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.coupon_redemption_state(timestamptz, text, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.coupon_uses(uuid) from public, anon, authenticated, service_role;
revoke all on function public.coupon_rejection(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.coupon_price_rejection(integer, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.coupon_reservation_summary(uuid) from public, anon, authenticated, service_role;
revoke all on function public.coupon_admin_input_error(text, integer, date, date, integer, text, uuid[], text) from public, anon, authenticated, service_role;
revoke all on function public.admin_coupon_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.reservation_standby_target_rejection(uuid, uuid, text) from public, anon, authenticated, service_role;

-- RPCs do servidor: somente a service role.
revoke all on function public.preview_coupon(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.coupon_field_visible(uuid) from public, anon, authenticated;
revoke all on function public.create_pre_reservation_with_coupon(uuid, text, text, text, text, integer, text, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_list_coupons(uuid) from public, anon, authenticated;
revoke all on function public.admin_get_coupon(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_create_coupon(uuid, text, integer, date, date, integer, text, uuid[], text, text) from public, anon, authenticated;
revoke all on function public.admin_update_coupon(uuid, uuid, text, integer, date, date, integer, text, uuid[], text) from public, anon, authenticated;
revoke all on function public.admin_set_coupon_status(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_release_coupon_redemption(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.preview_coupon(uuid, integer, text) to service_role;
grant execute on function public.coupon_field_visible(uuid) to service_role;
grant execute on function public.create_pre_reservation_with_coupon(uuid, text, text, text, text, integer, text, uuid, text) to service_role;
grant execute on function public.admin_list_coupons(uuid) to service_role;
grant execute on function public.admin_get_coupon(uuid, uuid) to service_role;
grant execute on function public.admin_create_coupon(uuid, text, integer, date, date, integer, text, uuid[], text, text) to service_role;
grant execute on function public.admin_update_coupon(uuid, uuid, text, integer, date, date, integer, text, uuid[], text) to service_role;
grant execute on function public.admin_set_coupon_status(uuid, uuid, text, text) to service_role;
grant execute on function public.admin_release_coupon_redemption(uuid, uuid, text) to service_role;
