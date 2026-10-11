-- Stage 1 / Migration 3: multi-tenant core tables
--
--   communities, memberships, permissions, roles, membership_roles,
--   role_permissions, role_templates, role_template_permissions
--
-- ON DELETE choices (see docs/database/schema.md for the full rationale):
--   * community children (memberships, roles)    -> RESTRICT
--       Communities are archived, never casually hard-deleted. RESTRICT stops
--       an accidental DELETE from silently wiping a tenant's membership history.
--   * user-owned rows (memberships.user_id)        -> CASCADE
--       Account deletion (right to erasure) must not be blocked.
--   * communities.created_by                       -> SET NULL
--       A community outlives its creator's account.
--   * pure join rows to their parent               -> CASCADE
--       (membership_roles -> memberships, role_permissions -> roles)
--   * references to grants that are still in use   -> RESTRICT
--       (membership_roles -> roles, role_permissions -> permissions)
--       Deleting an assigned role or a permission in use must be explicit.

-- ---------------------------------------------------------------------------
-- communities
-- ---------------------------------------------------------------------------
create table public.communities (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (char_length(btrim(name)) between 1 and 120),
  slug            text not null
                  constraint communities_slug_key unique
                  constraint communities_slug_format check (
                    char_length(slug) between 3 and 63
                    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                  ),
  description     text check (char_length(description) <= 2000),
  community_type  text not null default 'other'
                  check (community_type in (
                    'residential', 'church', 'school', 'club',
                    'association', 'organization', 'other'
                  )),
  logo_url        text check (char_length(logo_url) <= 2048),
  cover_image_url text check (char_length(cover_image_url) <= 2048),
  -- Platform-controlled lifecycle state. Not writable by clients.
  status          text not null default 'active'
                  check (status in ('active', 'suspended', 'archived')),
  timezone        text not null default 'UTC',
  settings        jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(settings) = 'object'),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.communities is 'Tenant root. Every community-owned row is scoped to a community.';
comment on column public.communities.slug is 'Globally unique, lowercase, URL-safe identifier.';

create trigger communities_set_updated_at
  before update on public.communities
  for each row execute function private.set_updated_at();

-- Timezone must be a real IANA zone. CHECK constraints cannot query the
-- catalog, so validate in a trigger (only fires when the value changes).
create or replace function private.validate_community_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'invalid timezone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_community_timezone() from public;

create trigger communities_validate_timezone
  before insert or update of timezone on public.communities
  for each row execute function private.validate_community_timezone();

-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------
create table public.memberships (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete restrict,
  user_id      uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'pending'
               check (status in ('pending', 'active', 'suspended', 'rejected', 'left')),
  joined_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint memberships_community_user_key unique (community_id, user_id),
  -- Target for the composite FK from membership_roles (tenant consistency).
  constraint memberships_id_community_key unique (id, community_id)
);

comment on table public.memberships is 'A user''s membership in one community. One row per (community, user).';

-- memberships.community_id lookups are served by the leading column of
-- memberships_community_user_key; no separate single-column index needed.
create index memberships_user_id_idx on public.memberships (user_id);
create index memberships_community_status_idx on public.memberships (community_id, status);

create trigger memberships_set_updated_at
  before update on public.memberships
  for each row execute function private.set_updated_at();

-- Stamp joined_at the first time a membership becomes active.
create or replace function private.set_membership_joined_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active' and new.joined_at is null then
    new.joined_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.set_membership_joined_at() from public;

create trigger memberships_set_joined_at
  before insert or update of status on public.memberships
  for each row execute function private.set_membership_joined_at();

-- ---------------------------------------------------------------------------
-- permissions (global catalog)
-- ---------------------------------------------------------------------------
create table public.permissions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null
              constraint permissions_key_key unique
              constraint permissions_key_format check (key ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  description text not null,
  module      text not null check (module ~ '^[a-z][a-z_]*$'),
  created_at  timestamptz not null default now(),
  -- The module is always the key prefix, e.g. posts.create -> posts.
  constraint permissions_module_matches_key check (split_part(key, '.', 1) = module)
);

comment on table public.permissions is 'Global permission catalog. Authorization always resolves to these keys.';

-- ---------------------------------------------------------------------------
-- roles (community-scoped)
-- ---------------------------------------------------------------------------
create table public.roles (
  id             uuid primary key default gen_random_uuid(),
  community_id   uuid not null references public.communities (id) on delete restrict,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  description    text check (char_length(description) <= 500),
  -- True for roles created from role_templates at community creation.
  -- System roles cannot be modified or deleted by clients.
  is_system_role boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Target for the composite FK from membership_roles (tenant consistency).
  constraint roles_id_community_key unique (id, community_id)
);

comment on table public.roles is
  'Community-scoped role. Names are labels only; authorization never checks role names.';

-- Role names are unique per community, case-insensitively. Also serves
-- roles.community_id lookups (leading column).
create unique index roles_community_name_key on public.roles (community_id, lower(name));

create trigger roles_set_updated_at
  before update on public.roles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- membership_roles
-- ---------------------------------------------------------------------------
-- community_id is denormalised here on purpose: the two composite foreign
-- keys make it impossible (at the constraint level) to attach a role from
-- Community B to a membership in Community A.
create table public.membership_roles (
  id            uuid primary key default gen_random_uuid(),
  community_id  uuid not null,
  membership_id uuid not null,
  role_id       uuid not null,
  created_at    timestamptz not null default now(),
  constraint membership_roles_membership_role_key unique (membership_id, role_id),
  constraint membership_roles_membership_fk
    foreign key (membership_id, community_id)
    references public.memberships (id, community_id) on delete cascade,
  constraint membership_roles_role_fk
    foreign key (role_id, community_id)
    references public.roles (id, community_id) on delete restrict
);

comment on table public.membership_roles is 'Assigns community roles to a membership. A membership may hold many roles.';

-- membership_id lookups (and the composite FK's cascade checks) are served by
-- the leading column of membership_roles_membership_role_key.
create index membership_roles_role_id_idx on public.membership_roles (role_id);

-- Derive community_id from the membership so clients only supply
-- (membership_id, role_id). Runs as the invoker: if the caller cannot see the
-- membership, community_id stays NULL and the insert fails.
create or replace function private.set_membership_role_community()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select m.community_id into new.community_id
  from public.memberships m
  where m.id = new.membership_id;
  return new;
end;
$$;

revoke all on function private.set_membership_role_community() from public;

create trigger membership_roles_set_community
  before insert on public.membership_roles
  for each row execute function private.set_membership_role_community();

-- ---------------------------------------------------------------------------
-- role_permissions
-- ---------------------------------------------------------------------------
create table public.role_permissions (
  role_id       uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete restrict,
  primary key (role_id, permission_id)
);

comment on table public.role_permissions is 'Grants permissions to a community role.';

-- role_id lookups are served by the primary key's leading column.
create index role_permissions_permission_id_idx on public.role_permissions (permission_id);

-- ---------------------------------------------------------------------------
-- role templates (default roles copied into every new community)
-- ---------------------------------------------------------------------------
create table public.role_templates (
  id                uuid primary key default gen_random_uuid(),
  key               text not null unique check (key ~ '^[a-z][a-z_]*$'),
  name              text not null unique check (char_length(btrim(name)) between 1 and 60),
  description       text,
  -- Exactly one template is granted to the community creator. This is how
  -- create_community() picks the creator's role without matching on names.
  assign_to_creator boolean not null default false,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now()
);

create unique index role_templates_single_creator_template
  on public.role_templates (assign_to_creator) where assign_to_creator;

comment on table public.role_templates is
  'Default role definitions copied into each new community. Changes affect only communities created afterwards.';

create table public.role_template_permissions (
  template_id   uuid not null references public.role_templates (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete restrict,
  primary key (template_id, permission_id)
);
