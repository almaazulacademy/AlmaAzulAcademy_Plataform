-- =============================================================================
-- ROLLBACK de 202610310002_experiences_legacy_columns_on_insert.sql — SOMENTE
-- PARA REVISÃO. NÃO EXECUTAR sem decisão explícita. Não está em
-- supabase/migrations/ de propósito, para nenhuma ferramenta aplicá-lo.
-- =============================================================================
--
-- Remove o gatilho e a função. Linhas já criadas ficam como estão (com as
-- colunas legadas preenchidas). Depois dele, criar experiência ou evento pelo
-- painel volta a falhar em produção (23502 em "eyebrow").

begin;
set local lock_timeout = '5s';

drop trigger if exists experiences_fill_legacy_columns on public.experiences;
drop function if exists public.experiences_fill_legacy_columns();

commit;
