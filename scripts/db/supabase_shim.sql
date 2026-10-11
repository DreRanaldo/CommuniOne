-- Minimal Supabase compatibility shim for running the migrations and pgTAP
-- tests against a PLAIN PostgreSQL database (CI, or machines without the
-- Supabase CLI / Docker).
--
-- NEVER apply this to a Supabase project: Supabase already provides all of
-- these objects. It is not a migration.
--
-- It reproduces only what the CommuniOne schema depends on:
--   * roles anon / authenticated / service_role (service_role bypasses RLS)
--   * schema auth with minimal auth.users / auth.sessions and auth.uid() / auth.jwt()
--   * schema extensions with pgTAP
--   * Supabase's default privileges (ALL on public objects to the API roles),
--     so the migrations' explicit REVOKEs are exercised exactly as in Supabase.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant anon, authenticated, service_role to current_user;

create schema if not exists extensions;
create schema if not exists auth;

grant usage on schema public, extensions, auth to anon, authenticated, service_role;

create extension if not exists pgtap with schema extensions;

create table if not exists auth.users (
  id                 uuid primary key,
  email              text unique,
  raw_user_meta_data jsonb,
  raw_app_meta_data  jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Subset of Supabase Auth's session table (one row per signed-in session;
-- deleted on sign-out).
create table if not exists auth.sessions (
  id         uuid primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  not_after  timestamptz
);

-- Same semantics as Supabase: identity comes from the verified JWT claims
-- that PostgREST places in request.jwt.claims.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant execute on all functions in schema auth to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

do $$
begin
  execute format('alter database %I set search_path = "$user", public, extensions', current_database());
end;
$$;
