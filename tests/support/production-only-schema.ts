/** O que a auditoria de 31/10/2026 mostrou em produção e as migrations não criam. */
export const PRODUCTION_ONLY = `
  alter table public.experiences
    add column eyebrow text not null default 'legado',
    add column short_description text not null default 'legado',
    add column location text not null default 'legado',
    add column cover_image text not null default 'legado',
    add column gallery jsonb not null default '[]'::jsonb,
    add column included jsonb not null default '[]'::jsonb,
    add column active boolean not null default true;
  alter table public.experiences
    alter column eyebrow drop default, alter column short_description drop default,
    alter column location drop default, alter column cover_image drop default;
  update public.experiences set active = (status = 'PUBLISHED');

  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select public.is_active_admin(auth.uid()) $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant execute on function public.is_admin() to anon, authenticated, service_role;

  create policy "Admins manage experiences" on public.experiences for all using (public.is_admin()) with check (public.is_admin());
  create policy "Public can view active experiences" on public.experiences for select using (active = true or public.is_admin());
  create policy "Admins manage sessions" on public.sessions for all using (public.is_admin()) with check (public.is_admin());
  create policy "Public can view scheduled future sessions" on public.sessions for select using ((status = 'OPEN' and starts_at > now()) or public.is_admin());

  grant usage on schema public to anon, authenticated, service_role;
  grant select on public.experiences, public.sessions, public.bases to anon, authenticated, service_role;

  create function public.create_reservation(p_session_id uuid, p_customer_name text, p_customer_email text, p_customer_phone text, p_participants integer, p_pix_code text)
  returns uuid language plpgsql security definer set search_path to '' as $f$
  declare target_session public.sessions%rowtype;
  begin
    if p_participants < 1 or p_participants > 10 then raise exception 'invalid_participant_count'; end if;
    select * into target_session from public.sessions where id = p_session_id for update;
    if target_session.id is null or target_session.status <> 'scheduled' or target_session.starts_at <= now() then raise exception 'session_unavailable'; end if;
    return null;
  end;
  $f$;
  grant execute on function public.create_reservation(uuid, text, text, text, integer, text) to public, anon, authenticated, service_role;
`;
