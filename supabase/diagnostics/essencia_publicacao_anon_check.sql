-- ESSÊNCIA — PUBLICAÇÃO SEM VENDAS — CONFERÊNCIA COMO anon (GERADO; SOMENTE LEITURA)
--
-- O postcheck roda com o dono do banco, que não passa pelas políticas. Aqui, com o
-- evento publicado e o interruptor ligado, o esperado é: evento_visivel = 1,
-- sessao_aberta_visivel = 0, regulares_visiveis igual ao preflight,
-- pode_pre_reservar = false e create_reservation_executavel = false ou nulo.

set local role anon;
select
  (select count(*) from public.experiences where slug = 'essencia' and kind = 'EVENT') as evento_visivel,
  (select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'essencia' and s.status = 'OPEN') as sessao_aberta_visivel,
  (select count(*) from public.experiences where kind = 'REGULAR' and status = 'PUBLISHED') as regulares_visiveis,
  has_function_privilege('anon', 'public.create_pre_reservation(uuid, text, text, text, text, integer, text, uuid)', 'execute') as pode_pre_reservar,
  case when to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)') is null then null
       else has_function_privilege('anon', to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)'), 'execute') end as create_reservation_executavel;
