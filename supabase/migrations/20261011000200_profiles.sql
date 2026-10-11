-- Stage 1 / Migration 2: profiles
--
-- One profile per authenticated user. profiles.id IS the auth user id.
-- No credentials (email, password, tokens) are stored here: those belong to
-- Supabase Auth (auth.users).

create table public.profiles (
  id           uuid primary key
               -- Profile is a pure extension of the auth account; deleting the
               -- account (e.g. a right-to-erasure request) removes the profile.
               references auth.users (id) on delete cascade,
  first_name   text check (char_length(first_name) <= 100),
  last_name    text check (char_length(last_name) <= 100),
  display_name text check (char_length(display_name) <= 100),
  avatar_url   text check (char_length(avatar_url) <= 2048),
  phone        text check (phone ~ '^\+?[0-9 ().-]{5,32}$'),
  bio          text check (char_length(bio) <= 1000),
  -- Platform-level account status. Not writable by clients (see RLS migration).
  status       text not null default 'active'
               check (status in ('active', 'suspended', 'deactivated')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is
  'Public-facing user profile. id = auth.users.id. Never stores credentials.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- Automatically create a profile when a user signs up.
--
-- SECURITY DEFINER is required because the trigger fires in the context of
-- the Supabase Auth service role, which has no privileges on public.profiles.
-- search_path is pinned to '' and every object is schema-qualified.
-- User-supplied metadata is trimmed and truncated so that sign-up can never
-- fail on a profile CHECK constraint.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (id, first_name, last_name, display_name, avatar_url)
  values (
    new.id,
    left(nullif(btrim(meta ->> 'first_name'), ''), 100),
    left(nullif(btrim(meta ->> 'last_name'), ''), 100),
    left(nullif(btrim(coalesce(meta ->> 'display_name', meta ->> 'full_name', meta ->> 'name')), ''), 100),
    case when char_length(meta ->> 'avatar_url') <= 2048 then nullif(btrim(meta ->> 'avatar_url'), '') end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Backfill profiles for users that existed before this migration so the
-- invariant "every auth user has a profile" holds in every environment.
insert into public.profiles (id)
select u.id from auth.users u
on conflict (id) do nothing;
