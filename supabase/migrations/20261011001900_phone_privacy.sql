-- Pre-Stage 12 / Migration 19: phone number privacy
--
-- Policy: phone numbers are PRIVATE to their owner. Co-members, community
-- administrators and community Owners cannot read them. No product feature
-- currently needs administrators to see phone numbers, so no
-- "members.view_phone" permission is introduced (see
-- docs/architecture/privacy.md for how to add one deliberately later).
--
-- Why a separate table rather than hiding a column: profiles are readable
-- by co-members (Stage 1/3 rules). Column-level revokes would make every
-- `select *` on profiles fail and are easy to undo by accident. Moving the
-- phone into public.profile_private, whose RLS allows ONLY the owner, makes
-- it impossible to leak through profile queries, member lists, embeds,
-- joins or RPCs that read profiles.
--
-- Existing phone numbers are migrated; nothing is lost.

create table public.profile_private (
  -- Defaults to the caller; not client-writable.
  user_id    uuid primary key default private.current_active_user_id()
             references public.profiles (id) on delete cascade,
  phone      text check (phone ~ '^\+?[0-9 ().-]{5,32}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profile_private is
  'Private contact details. Readable and writable only by the user they belong to.';

insert into public.profile_private (user_id, phone)
select p.id, btrim(p.phone) from public.profiles p
where nullif(btrim(p.phone), '') is not null;

create trigger profile_private_set_updated_at
  before update on public.profile_private
  for each row execute function private.set_updated_at();

create or replace function private.normalize_profile_private()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'user_id is immutable' using errcode = '42501';
  end if;
  new.phone := nullif(btrim(new.phone), '');
  return new;
end;
$$;

revoke all on function private.normalize_profile_private() from public, anon, authenticated;

create trigger profile_private_normalize
  before insert or update on public.profile_private
  for each row execute function private.normalize_profile_private();

-- profiles no longer carries the phone number.
create or replace function private.normalize_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.first_name   := nullif(btrim(new.first_name), '');
  new.last_name    := nullif(btrim(new.last_name), '');
  new.display_name := nullif(btrim(new.display_name), '');
  new.avatar_url   := nullif(btrim(new.avatar_url), '');
  new.bio          := nullif(btrim(new.bio), '');
  return new;
end;
$$;

alter table public.profiles drop column phone;

-- ---------------------------------------------------------------------------
-- Privileges and RLS: owner only
-- ---------------------------------------------------------------------------
revoke all on table public.profile_private from public, anon, authenticated;
grant all on table public.profile_private to service_role;
alter table public.profile_private enable row level security;

grant select on public.profile_private to authenticated;
grant insert (phone) on public.profile_private to authenticated;
grant update (phone) on public.profile_private to authenticated;
grant delete on public.profile_private to authenticated;

-- Reading your own details needs only a live session (also while suspended,
-- like your own profile); changing them needs an active account.
create policy profile_private_select_own on public.profile_private
  for select to authenticated
  using (user_id = (select private.current_session_user_id()));

create policy profile_private_insert_own on public.profile_private
  for insert to authenticated
  with check (user_id = (select private.current_active_user_id()));

create policy profile_private_update_own on public.profile_private
  for update to authenticated
  using (user_id = (select private.current_active_user_id()))
  with check (user_id = (select private.current_active_user_id()));

create policy profile_private_delete_own on public.profile_private
  for delete to authenticated
  using (user_id = (select private.current_active_user_id()));
