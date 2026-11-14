-- ESSÊNCIA — Corpo, Mente e Natureza — PUBLICAÇÃO — CONFERÊNCIA COMO anon (SOMENTE LEITURA) (GERADO por `pnpm events:edition-launch-sql essencia-lua-cheia`; NÃO EDITAR À MÃO)
--
-- O postcheck roda com o dono do banco, que não passa pelas políticas. Aqui, como a
-- chave pública, o esperado com a edição publicada e a sessão fechada é:
-- evento_visivel = 1, sessao_aberta_visivel = 0, sessao_reservavel = 0 e
-- pode_pre_reservar = false.

begin;
set local role anon;
select
  (select count(*) from public.experiences where slug = 'essencia-lua-cheia' and kind = 'EVENT') as evento_visivel,
  (select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'essencia-lua-cheia' and s.status = 'OPEN') as sessao_aberta_visivel,
  ((select count(*) from public.list_open_sessions('essencia-lua-cheia')) + (select count(*) from public.list_public_sessions('essencia-lua-cheia'))) as sessao_reservavel,
  has_function_privilege('anon', 'public.create_pre_reservation(uuid, text, text, text, text, integer, text, uuid)', 'execute') as pode_pre_reservar;
rollback;
