-- SESSÕES HISTÓRICAS FORA DA PLANILHA — IDS COMPLETOS (SOMENTE LEITURA)
--
-- O documento do incidente (`docs/incident-2026-10-google-sheets-grid-limit.md`)
-- registra as 14 sessões só pelos oito primeiros caracteres do `session_id`. A
-- proteção da planilha (`lib/integrations/google-sheets/frozen-sessions.ts`)
-- compara o id inteiro, e só aceita id completo e confirmado.
--
-- Esta consulta devolve o id completo de cada uma, com o suficiente para
-- conferir que é a sessão certa. Um único SELECT, nenhuma escrita e nenhum dado
-- pessoal: só sessão, experiência, horário e contagens.
--
-- Esperado: exatamente 14 linhas, uma por prefixo, todas anteriores a
-- 19/08/2026. A soma de `reservas_confirmadas` era 97 (200 vagas) em 09/10/2026.
-- Se vierem mais de 14 linhas, dois ids compartilham um prefixo: não use a lista
-- sem conferir qual deles é a sessão histórica.

select
  s.id as session_id,
  left(s.id::text, 8) as prefixo,
  e.title as experiencia,
  to_char(s.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as inicio,
  s.status::text as status,
  count(r.id) filter (where r.status = 'CONFIRMED') as reservas_confirmadas,
  coalesce(sum(r.quantity) filter (where r.status = 'CONFIRMED'), 0) as vagas_confirmadas
from public.sessions s
join public.experiences e on e.id = s.experience_id
left join public.reservations r on r.session_id = s.id
where left(s.id::text, 8) in (
  '0a98cf4c', '0ca42ebe', '49a818bf', '4d77bf1d', '5589d4c6', '6547901a', '86480dee',
  '87077465', '8796cfff', '8d78dd76', '9b40060d', 'c3969f2c', 'c42e5181', 'd47907c1'
)
group by s.id, e.title, s.starts_at, s.status
order by s.starts_at, s.id;
