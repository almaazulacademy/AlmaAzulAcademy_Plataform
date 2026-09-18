-- Fecha a escalada de privilégio via `profiles.role`.
--
-- Encontrado em produção (schema legado `initial_schema`, fora deste
-- repositório): `anon`/`authenticated` tinham UPDATE/INSERT em
-- `profiles.role`, a policy "Users update own profile" não restringia colunas e
-- `is_admin()` lia `profiles.role = 'admin'`. Qualquer usuário logado podia se
-- promover a admin e, pelas policies "Admins manage …", criar/alterar/apagar
-- `experiences`, `sessions` e todos os `profiles` pela API pública.
--
-- O app nunca usa esse caminho: toda escrita passa por RPCs com service role e
-- a autorização do painel vem de `admin_users`. Por isso a correção só tira
-- permissões que ninguém legítimo usa:
--   * `profiles`: cliente só altera `full_name` e `phone` do próprio perfil;
--   * `is_admin()` passa a seguir `admin_users` (via `is_active_admin`), a
--     mesma fonte de verdade do painel — nunca mais uma coluna editável;
--   * `experiences` e `sessions`: sem escrita para `anon`/`authenticated`
--     (leitura pública continua igual).
--
-- Idempotente e tolerante a ambientes sem o schema legado: cada bloco só age
-- se o objeto existir.

do $$
begin
  if to_regclass('public.profiles') is not null then
    revoke insert, update, delete, truncate on public.profiles from anon, authenticated;
    grant update (full_name, phone) on public.profiles to authenticated;
  end if;

  if to_regclass('public.experiences') is not null then
    revoke insert, update, delete, truncate on public.experiences from anon, authenticated;
  end if;

  if to_regclass('public.sessions') is not null then
    revoke insert, update, delete, truncate on public.sessions from anon, authenticated;
  end if;

  if to_regprocedure('public.is_admin()') is not null then
    execute $fn$
      create or replace function public.is_admin()
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select public.is_active_admin(auth.uid());
      $body$;
    $fn$;
  end if;
end;
$$;
