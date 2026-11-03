-- =============================================================================
-- ROLLBACK de 202611020001_discount_coupons.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O rollback operacional dos cupons é desligar COUPONS_CHECKOUT_ENABLED e
-- COUPONS_ADMIN_ENABLED (ou desativar o cupom pelo painel). Este script é o
-- rollback do banco, para quando a migration precisar sair inteira.
--
-- O que faz: remove as vinte funções criadas pela
-- migration e as quatro tabelas (cupons, experiências do cupom, usos e o
-- valor mínimo), e devolve `reservation_standby_target_rejection` ao corpo de
-- 202610130002_reservation_standby.sql, byte a byte.
--
-- Recusa (e não muda nada) se existir qualquer uso de cupom registrado — de
-- compra confirmada ou não. Uma reserva com cupom guarda em `unit_price_cents`
-- o valor com desconto, e o preço de lista, o percentual e o desconto só
-- existem em `coupon_redemptions`: apagar essa tabela apagaria o histórico
-- financeiro, e o Stand-by passaria a recusar a turma de mesmo preço de lista
-- dessas reservas. Cupons cadastrados e nunca usados são removidos junto — a
-- configuração do painel se perde.
--
-- ## Concorrência
--
-- Uma compra com cupom pode estar em curso em outra conexão. Contar os usos sem
-- trava não basta: o uso gravado por uma transação ainda aberta é invisível, e
-- os DROP apagariam esse histórico assim que ela confirmasse. Por isso a
-- verificação e a remoção acontecem na mesma transação, depois de travar em
-- ACCESS EXCLUSIVE, de uma vez só, todas as tabelas que a remoção precisa:
--
--   reservations → experiences → coupon_settings → coupons
--   → coupon_experiences → coupon_redemptions
--
-- `reservations` e `experiences` entram porque apagar uma tabela com chave
-- estrangeira para elas trava a tabela referenciada em ACCESS EXCLUSIVE (medido
-- no Postgres 17). Travá-las depois, já segurando as de cupom, criaria ciclo
-- com uma compra, que pega `reservations` primeiro e os cupons depois — a mesma
-- ordem da lista acima.
--
-- A trava é tudo ou nada: `LOCK … NOWAIT` numa subtransação, repetido a cada
-- 50 ms por até 10 s. Uma tentativa que falha devolve o que tinha pegado, então
-- o rollback nunca espera segurando trava — não entra em ciclo de deadlock com
-- ninguém. Esgotado o prazo, aborta com ROLLBACK_SEM_TRAVA, sem mudar nada:
-- é só rodar de novo num momento mais calmo.
--
-- Com as travas:
--   * toda transação que já tocou essas tabelas terminou (ACCESS EXCLUSIVE
--     espera por todas), e a contagem — feita depois, com leitura nova — vê o
--     uso que ela confirmou, ou não vê o que ela desfez;
--   * uma compra que chegar agora espera; quando o rollback confirma, as tabelas
--     e as funções já não existem e ela falha inteira, sem pré-reserva.
--
-- Efeito no site: enquanto o rollback roda (milissegundos), leituras e escritas
-- em `reservations` e `experiences` esperam. Rodar fora do horário de vendas.
--
-- O que NÃO faz: não toca reserva, sessão, pagamento, Stand-by, lista de
-- espera, auditoria (os registros COUPON_* ficam em admin_audit_log) nem
-- nenhuma outra função existente. Reaplicar a migration devolve tudo, sem
-- cupom nenhum e com o valor mínimo nulo.

begin;
set local lock_timeout = '5s';

do $$
declare
  attempts integer := 0;
  used integer := 0;
begin
  -- Rollback já feito: nada a travar; o resto do script é idempotente.
  if to_regclass('public.coupon_redemptions') is null then return; end if;

  loop
    begin
      lock table public.reservations, public.experiences, public.coupon_settings,
                 public.coupons, public.coupon_experiences, public.coupon_redemptions
        in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      attempts := attempts + 1;
      if attempts >= 200 then
        raise exception 'ROLLBACK_SEM_TRAVA: há transações usando reservas ou cupons há mais de 10 s. Nada foi alterado; tente de novo.';
      end if;
      perform pg_sleep(0.05);
    end;
  end loop;

  -- Leitura nova, depois das travas: nenhuma transação com uso pendente existe mais.
  select count(*) into used from public.coupon_redemptions;
  if used > 0 then
    raise exception 'ROLLBACK_RECUSADO: existem % uso(s) de cupom registrados. Nada foi alterado.', used;
  end if;
end;
$$;

drop function if exists public.admin_release_coupon_redemption(uuid, uuid, text);
drop function if exists public.admin_set_coupon_status(uuid, uuid, text, text);
drop function if exists public.admin_update_coupon(uuid, uuid, text, integer, date, date, integer, text, uuid[], text);
drop function if exists public.admin_create_coupon(uuid, text, integer, date, date, integer, text, uuid[], text, text);
drop function if exists public.admin_get_coupon(uuid, uuid);
drop function if exists public.admin_list_coupons(uuid);
drop function if exists public.admin_coupon_json(uuid);
drop function if exists public.coupon_admin_input_error(text, integer, date, date, integer, text, uuid[], text);
drop function if exists public.create_pre_reservation_with_coupon(uuid, text, text, text, text, integer, text, uuid, text);
drop function if exists public.coupon_field_visible(uuid);
drop function if exists public.preview_coupon(uuid, integer, text);
drop function if exists public.coupon_reservation_summary(uuid);
drop function if exists public.coupon_price_rejection(integer, integer, integer);
drop function if exists public.coupon_rejection(uuid, uuid);
drop function if exists public.coupon_uses(uuid);
drop function if exists public.coupon_redemption_state(timestamptz, text, timestamptz, timestamptz);
drop function if exists public.coupon_discounted_unit_cents(integer, integer);
drop function if exists public.coupon_today();
drop function if exists public.coupon_normalize_code(text);

-- O corpo de antes dos cupons, idêntico ao de 202610130002_reservation_standby.sql.
-- Precisa vir antes de apagar `coupon_redemptions`: a versão nova lê a tabela.
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

  if p_mode = 'CUSTOMER' and candidate.price_cents <> target.unit_price_cents then
    return 'PRICE_NOT_ELIGIBLE';
  end if;

  return null;
end;
$$;


revoke all on function public.reservation_standby_target_rejection(uuid, uuid, text) from public, anon, authenticated, service_role;

-- O gatilho do histórico sai junto com a tabela.
drop table if exists public.coupon_redemptions;
drop table if exists public.coupon_experiences;
drop table if exists public.coupon_settings;
drop table if exists public.coupons;

drop function if exists public.enforce_coupon_redemption_history();

commit;
