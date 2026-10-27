-- =====================================================================
-- LOCAL TEST STUB ONLY — never run this against a real Supabase project.
-- =====================================================================
-- A real Supabase project already provides `auth.users`, `auth.uid()`,
-- `auth.role()`, and the `authenticated` role. This file exists purely so
-- 0001_init_schema.sql (which references all of those) can be validated
-- against a throwaway local Postgres instance during development.
-- =====================================================================

create schema if not exists auth;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
end $$;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- Supabase's real auth.uid() reads the `sub` claim out of the request JWT.
-- We fake that by reading a session GUC instead, so a test script can do
-- `set request.jwt.claim.sub = '<uuid>'` to simulate "logged in as X".
create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

create or replace function auth.role() returns text
  language sql stable as $$
    select current_setting('request.jwt.claim.role', true)
  $$;

do $$
begin
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

grant usage on schema public to authenticated;
grant usage on schema auth to authenticated;
