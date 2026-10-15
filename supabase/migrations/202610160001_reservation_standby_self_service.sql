-- Autoatendimento do reagendamento de Stand-by (etapa 5 de 6).
--
-- Depende de `202610130002_reservation_standby.sql` e de
-- `202610150001_reservation_reschedule_email.sql`.
--
-- Aditiva e idempotente. Cria duas tabelas e duas funções. **Não substitui o
-- corpo de nenhuma função existente** e não altera reserva, sessão, pagamento,
-- autorização de Stand-by nem linha de histórico. Depois de aplicada, nada muda
-- no comportamento do site: as duas funções novas só são chamadas pelas rotas
-- públicas da etapa 5, que respondem 404 enquanto `STANDBY_SELF_SERVICE_ENABLED`
-- não for `true`.
--
-- ## O que já existia e continua sendo o caminho
--
-- `customer_reschedule_options` e `customer_reschedule_reservation`, da etapa 2,
-- resolvem a credencial (CPF + código, ou o token do link) para a autorização,
-- montam a lista de turmas pela mesma régua do núcleo e entregam a escolha a
-- `reservation_standby_resolve`. Uso único, mesmo valor, vaga para o grupo
-- inteiro, auditoria e — desde a etapa 4 — a linha da fila do e-mail são todos
-- do núcleo. Esta migration não toca em nada disso.
--
-- ## O que faltava
--
--   1. **Limite de tentativas.** A etapa 2 deixou para a rota pública "limite de
--      tentativas e checagem de origem". A origem é conferida na rota. O limite
--      precisa de estado compartilhado entre as instâncias do servidor — na
--      Vercel cada requisição pode cair em uma instância diferente, e um
--      contador em memória não limita nada. O estado fica aqui.
--
--   2. **O que dizer quando não há o que escolher.** `customer_reschedule_options`
--      devolve null para qualquer credencial sem autorização aberta, de
--      propósito: não confirma a existência de reserva. Mas, para quem
--      **comprovou** a credencial, "já reagendada", "cancelada" e "link
--      substituído" são respostas diferentes, e o cliente precisa da certa.
--      `customer_reschedule_overview` devolve esse estado, sem dado novo além do
--      que a consulta pública da reserva já mostra a quem tem CPF e código.

-- ---------------------------------------------------------------------------
-- 1. Limite de tentativas
-- ---------------------------------------------------------------------------
--
-- Janelas fixas por balde. Um balde é a origem da requisição (o endereço do
-- cliente) ou a credencial tentada (o código da reserva, ou o token do link).
-- Toda tentativa conta, certa ou errada: quem acerta usa duas ou três, quem
-- procura reservas usa centenas.
--
-- O balde é guardado como HMAC com um segredo que só existe neste banco: nem o
-- endereço, nem o código, nem o token ficam legíveis aqui, e o espaço de
-- endereços IPv4 não basta para desfazer o hash sem o segredo.

create table if not exists public.customer_access_throttle_secret (
  singleton boolean primary key default true check (singleton),
  secret bytea not null,
  created_at timestamptz not null default now()
);

insert into public.customer_access_throttle_secret (singleton, secret)
select true, extensions.gen_random_bytes(32)
where not exists (select 1 from public.customer_access_throttle_secret);

create table if not exists public.customer_access_throttle (
  bucket text primary key,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0
);

do $$ begin
  alter table public.customer_access_throttle
    add constraint customer_access_throttle_bucket_format
    check (bucket ~ '^(client|credential):[0-9a-f]{64}$');
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.customer_access_throttle
    add constraint customer_access_throttle_attempts_positive
    check (attempts > 0);
exception when duplicate_object then null;
end $$;

create index if not exists customer_access_throttle_window_idx
  on public.customer_access_throttle (window_started_at);

-- Ninguém lê nem escreve aqui pela API, nem a service role: o segredo e os
-- contadores só são alcançados pela função abaixo.
alter table public.customer_access_throttle_secret enable row level security;
alter table public.customer_access_throttle enable row level security;
revoke all on table public.customer_access_throttle_secret from public, anon, authenticated, service_role;
revoke all on table public.customer_access_throttle from public, anon, authenticated, service_role;

-- Registra uma tentativa e diz se ela cabe no limite.
--
-- O contador é um único `insert ... on conflict do update`: duas requisições
-- simultâneas no mesmo balde se enfileiram no lock da linha, e cada uma lê o
-- valor que a outra gravou. Não existe janela em que as duas leem "abaixo do
-- limite" e passam.
--
-- Limites fixos, aqui e não na aplicação, para o servidor não ter como
-- afrouxá-los por engano:
--
--   origem     — 30 tentativas a cada 15 minutos;
--   credencial — 10 tentativas a cada 15 minutos.
--
-- O balde da credencial usa o código da reserva sem o CPF: quem conhece um
-- código e tenta adivinhar o CPF esbarra em 10 tentativas por janela, venha de
-- quantos endereços vier. O efeito colateral aceito é que quem insiste com o
-- código de outra pessoa trava esse código por 15 minutos; o dono ainda tem o
-- link individual e o WhatsApp.
--
-- Devolve `{allowed, retryAfterSeconds}`. Tentativa barrada também conta.
create or replace function public.customer_reschedule_throttle(
  p_client_address text,
  p_cpf text,
  p_public_code text,
  p_link_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  key bytea;
  client_value text := lower(trim(coalesce(p_client_address, '')));
  token text := lower(trim(coalesce(p_link_token, '')));
  code text := upper(trim(coalesce(p_public_code, '')));
  credential_value text;
  client_bucket text;
  credential_bucket text;
  client_window interval := interval '15 minutes';
  credential_window interval := interval '15 minutes';
  client_limit integer := 30;
  credential_limit integer := 10;
  client_row public.customer_access_throttle%rowtype;
  credential_row public.customer_access_throttle%rowtype;
  retry_after integer := 0;
begin
  select s.secret into key from public.customer_access_throttle_secret s where s.singleton;
  if key is null then
    raise exception 'THROTTLE_NOT_CONFIGURED' using errcode = '55000';
  end if;

  -- Sem endereço conhecido, todas as requisições dividem o mesmo balde: o
  -- limite fica mais apertado, nunca mais frouxo.
  if client_value = '' then client_value := 'unknown'; end if;
  credential_value := case
    when token <> '' then 'link:' || left(token, 128)
    else 'code:' || left(code, 64)
  end;

  client_bucket := 'client:' || encode(hmac(convert_to('client:' || left(client_value, 128), 'UTF8'), key, 'sha256'), 'hex');
  credential_bucket := 'credential:' || encode(hmac(convert_to(credential_value, 'UTF8'), key, 'sha256'), 'hex');

  insert into public.customer_access_throttle as t (bucket, window_started_at, attempts)
  values (client_bucket, now(), 1)
  on conflict (bucket) do update
  set attempts = case when t.window_started_at <= now() - client_window then 1 else t.attempts + 1 end,
      window_started_at = case when t.window_started_at <= now() - client_window then now() else t.window_started_at end
  returning * into client_row;

  insert into public.customer_access_throttle as t (bucket, window_started_at, attempts)
  values (credential_bucket, now(), 1)
  on conflict (bucket) do update
  set attempts = case when t.window_started_at <= now() - credential_window then 1 else t.attempts + 1 end,
      window_started_at = case when t.window_started_at <= now() - credential_window then now() else t.window_started_at end
  returning * into credential_row;

  if client_row.attempts > client_limit then
    retry_after := greatest(retry_after, ceil(extract(epoch from (client_row.window_started_at + client_window - now())))::integer);
  end if;
  if credential_row.attempts > credential_limit then
    retry_after := greatest(retry_after, ceil(extract(epoch from (credential_row.window_started_at + credential_window - now())))::integer);
  end if;

  -- Faxina: baldes parados há mais de um dia. Poucos por chamada, para o custo
  -- ficar fixo.
  delete from public.customer_access_throttle
  where bucket in (
    select t.bucket from public.customer_access_throttle t
    where t.window_started_at < now() - interval '1 day'
    limit 50
  );

  return jsonb_build_object(
    'allowed', client_row.attempts <= client_limit and credential_row.attempts <= credential_limit,
    'retryAfterSeconds', greatest(retry_after, 0)
  );
end;
$$;

comment on function public.customer_reschedule_throttle(text, text, text, text) is
  'Limite de tentativas do autoatendimento de Stand-by: 30 por origem e 10 por credencial a cada 15 minutos. Toda tentativa conta.';

-- ---------------------------------------------------------------------------
-- 2. O que o cliente vê
-- ---------------------------------------------------------------------------
--
-- Uma chamada por tela. Devolve null quando a credencial não corresponde a
-- nenhuma autorização — sem distinguir "não existe" de "nunca esteve em
-- Stand-by". Com a credencial comprovada:
--
--   OPEN        — autorização aberta: o mesmo conteúdo de
--                 `customer_reschedule_options`, chamada e não copiada, mais o
--                 estado.
--   RESCHEDULED — a autorização desta credencial foi a última da reserva, já foi
--                 usada (pelo cliente ou pela equipe, para outra turma ou para a
--                 original) e a reserva está confirmada. Traz a turma em que a
--                 reserva está **agora**.
--   CANCELLED   — a reserva foi cancelada.
--   LINK_REPLACED — o link é de uma autorização anterior: a reserva voltou ao
--                 Stand-by depois e tem outra autorização. O link antigo não dá
--                 acesso à nova, nem diz nada sobre ela.
--   CLOSED      — qualquer outro encerramento.
--
-- Nenhum estado traz CPF, telefone, e-mail, sobrenome, valor pago, token ou id
-- interno da reserva.
create or replace function public.customer_reschedule_overview(
  p_cpf text,
  p_public_code text,
  p_link_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  access_row record;
  standby public.reservation_standby%rowtype;
  target public.reservations%rowtype;
  latest_id uuid;
  options jsonb;
  current_session jsonb;
begin
  -- Para CPF + código a aberta vem primeiro, depois a mais recente; o link
  -- corresponde a no máximo uma autorização.
  select a.* into access_row
  from public.reservation_standby_access(p_cpf, p_public_code, p_link_token) a
  limit 1;
  if not found then return null; end if;

  select * into standby from public.reservation_standby where id = access_row.standby_id;
  select * into target from public.reservations where id = access_row.reservation_id;
  if not found then return null; end if;

  if access_row.is_open and target.status = 'AWAITING_RESCHEDULE' then
    options := public.customer_reschedule_options(p_cpf, p_public_code, p_link_token);
    if options is not null then
      return options || jsonb_build_object('state', 'OPEN');
    end if;
  end if;

  latest_id := public.reservation_latest_standby(target.id);
  if latest_id is distinct from standby.id then
    return jsonb_build_object('state', 'LINK_REPLACED', 'publicCode', target.public_code);
  end if;

  if target.status = 'CANCELLED' then
    return jsonb_build_object('state', 'CANCELLED', 'publicCode', target.public_code);
  end if;

  if standby.resolution in ('RESCHEDULED', 'RESTORED') and target.status = 'CONFIRMED' then
    select jsonb_build_object(
             'sessionId', s.id,
             'startsAt', s.starts_at,
             'durationMinutes', s.duration_minutes,
             'experienceTitle', e.title,
             'baseName', coalesce(b.name, '')
           )
    into current_session
    from public.sessions s
    join public.experiences e on e.id = s.experience_id
    left join public.bases b on b.id = e.base_id
    where s.id = target.session_id;

    return jsonb_build_object(
      'state', 'RESCHEDULED',
      'publicCode', target.public_code,
      'firstName', split_part(trim(target.full_name), ' ', 1),
      'quantity', target.quantity,
      'resolvedBy', standby.resolved_by_type,
      'resolvedAt', standby.resolved_at,
      'session', current_session
    );
  end if;

  return jsonb_build_object('state', 'CLOSED', 'publicCode', target.public_code);
end;
$$;

comment on function public.customer_reschedule_overview(text, text, text) is
  'Tela do autoatendimento de Stand-by: turmas elegíveis com a autorização aberta, ou o estado dela depois de encerrada. Null para credencial desconhecida.';

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
--
-- O Postgres concede EXECUTE a PUBLIC em toda função nova. As duas só pela
-- service role: o navegador fala com o servidor da aplicação, que confere a
-- origem e chama o limite antes de qualquer outra coisa.
revoke all on function public.customer_reschedule_throttle(text, text, text, text) from public, anon, authenticated;
revoke all on function public.customer_reschedule_overview(text, text, text) from public, anon, authenticated;

grant execute on function public.customer_reschedule_throttle(text, text, text, text) to service_role;
grant execute on function public.customer_reschedule_overview(text, text, text) to service_role;
