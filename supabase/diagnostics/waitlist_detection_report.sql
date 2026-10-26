-- LISTA DE ESPERA — RELATÓRIO DA DETECÇÃO (SOMENTE LEITURA)
--
-- Para conferir, antes ou depois de ligar a detecção, o que a varredura veria
-- agora em cada turma com inscrição ativa. Nenhuma escrita e nenhum dado
-- pessoal: só contagens por turma.
--
--   vagas_oficiais   — available_spots (a fonte oficial).
--   vagas_detectadas — o que a detecção considera: available_spots menos as
--                      pré-reservas com checkout vencidas e ainda sem janela de
--                      pagamento (voltam a ocupar no próximo minuto).
--   cabem_agora      — inscrições ativas cujo grupo cabe nas vagas detectadas.
--   seriam_avisadas  — o tamanho da próxima onda pela régua aprovada.

select
  s.id as sessao,
  e.title as experiencia,
  to_char(s.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as inicio,
  s.status as status_da_turma,
  e.status as status_da_experiencia,
  s.capacity as capacidade,
  public.available_spots(s.id) as vagas_oficiais,
  public.waitlist_detection_spots(s.id) as vagas_detectadas,
  (select count(*) from public.waitlist_entries we where we.session_id = s.id and we.status = 'ACTIVE') as inscricoes_ativas,
  (select count(*) from public.waitlist_entries we where we.session_id = s.id and we.status = 'ACTIVE' and we.quantity <= public.waitlist_detection_spots(s.id)) as cabem_agora,
  (select count(*) from public.waitlist_eligible_entries(s.id, public.waitlist_detection_spots(s.id))) as seriam_avisadas,
  (select o.opened_at from public.waitlist_openings o where o.session_id = s.id and o.closed_at is null) as abertura_desde,
  (select count(*) from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id
    where we.session_id = s.id and n.kind = 'SPOT_AVAILABLE' and n.status = 'QUEUED') as avisos_na_fila
from public.sessions s
join public.experiences e on e.id = s.experience_id
where exists (select 1 from public.waitlist_entries we where we.session_id = s.id and we.status = 'ACTIVE')
order by s.starts_at;
