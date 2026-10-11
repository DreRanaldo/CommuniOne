-- Pre-Stage 12 / Migration 20: community invitations (Stage 4)
--
-- Shareable invitation links / codes that admit people to a community.
--
-- Token security
--   * 244 bits of randomness (two gen_random_uuid() values, which use the
--     operating system's cryptographically secure generator), presented
--     once as "ci_<64 hex chars>"
--   * only a SHA-256 hash is stored; the raw token is returned once at
--     creation and can never be read back (not even by administrators)
--   * guessing is infeasible (2^244 possibilities); token_hash is never
--     exposed to clients
--
-- Redemption (public.redeem_invitation) is ONE atomic function:
--   authenticate → hash → lock the invitation row (FOR UPDATE) → validate
--   status / expiry / usage / creator still authorised / community active →
--   create or re-activate the membership (the default Member role is
--   assigned by the Stage 3 lifecycle trigger) → record the redemption →
--   increment use_count → mark exhausted invitations 'expired'.
--   The row lock serialises concurrent redemptions of the same invitation,
--   so max_uses can never be exceeded.
--
-- An invitation never bypasses membership security: suspended members
-- cannot use one to reinstate themselves, active members are not
-- duplicated, and an invitation stops working as soon as its creator loses
-- members.invite in that community.

create table public.invitations (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete restrict,
  -- Account deletion keeps the invitation record, but a creator-less
  -- invitation can no longer be redeemed (see redeem_invitation).
  created_by   uuid references public.profiles (id) on delete set null,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz not null,
  max_uses     integer check (max_uses between 1 and 10000),
  use_count    integer not null default 0 check (use_count >= 0),
  status       text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  revoked_at   timestamptz,
  revoked_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint invitations_within_max_uses check (max_uses is null or use_count <= max_uses),
  constraint invitations_expiry_after_creation check (expires_at > created_at)
);

comment on table public.invitations is
  'Community invitations. Only a SHA-256 hash of the token is stored. See docs/features/invitations.md.';

create index invitations_community_created_idx on public.invitations (community_id, created_at desc);
create index invitations_created_by_idx on public.invitations (created_by);
create index invitations_revoked_by_idx on public.invitations (revoked_by) where revoked_by is not null;

create trigger invitations_set_updated_at
  before update on public.invitations
  for each row execute function private.set_updated_at();

-- Usage tracking: who joined through which invitation.
create table public.invitation_redemptions (
  id            uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.invitations (id) on delete cascade,
  community_id  uuid not null references public.communities (id) on delete restrict,
  -- Personal record: removed with the account.
  user_id       uuid not null references public.profiles (id) on delete cascade,
  membership_id uuid references public.memberships (id) on delete set null,
  redeemed_at   timestamptz not null default now(),
  constraint invitation_redemptions_once_per_user unique (invitation_id, user_id)
);

create index invitation_redemptions_community_idx on public.invitation_redemptions (community_id, redeemed_at desc);
create index invitation_redemptions_user_idx on public.invitation_redemptions (user_id);
-- Member removal sets membership_id to NULL here; keep that lookup indexed.
create index invitation_redemptions_membership_idx on public.invitation_redemptions (membership_id);

-- Nothing in an invitation is editable after creation except by the
-- functions below (no client UPDATE grant exists). Belt and braces for
-- trusted code: identity columns never change.
create or replace function private.protect_invitation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.community_id is distinct from old.community_id
     or new.token_hash is distinct from old.token_hash
     or new.created_at is distinct from old.created_at
     or (new.created_by is distinct from old.created_by and not private.is_account_erasure(old.created_by, new.created_by)) then
    raise exception 'invitation community, token and creator are immutable' using errcode = '42501';
  end if;
  if new.use_count < old.use_count then
    raise exception 'use_count can only increase' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_invitation() from public, anon, authenticated;

create trigger invitations_protect
  before update on public.invitations
  for each row execute function private.protect_invitation();

-- ---------------------------------------------------------------------------
-- Token helpers
-- ---------------------------------------------------------------------------
create or replace function private.invitation_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;

revoke all on function private.invitation_token_hash(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Create / revoke (members.invite)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: clients have no INSERT on invitations. Returns the raw
-- token exactly once.
create or replace function public.create_invitation(
  p_community_id uuid,
  p_expires_in   interval default interval '7 days',
  p_max_uses     integer default null
)
returns table (invitation_id uuid, token text, expires_at timestamptz, max_uses integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user  uuid := private.current_active_user_id();
  v_token text;
  v_id    uuid;
  v_exp   timestamptz;
begin
  if v_user is null or not public.has_community_permission(p_community_id, 'members.invite') then
    raise exception 'members.invite is required in this community' using errcode = '42501';
  end if;
  if p_expires_in is null or p_expires_in < interval '1 hour' or p_expires_in > interval '30 days' then
    raise exception 'invitations must expire between 1 hour and 30 days from now' using errcode = '22023';
  end if;
  if p_max_uses is not null and (p_max_uses < 1 or p_max_uses > 10000) then
    raise exception 'max_uses must be between 1 and 10000' using errcode = '22023';
  end if;

  v_token := 'ci_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  insert into public.invitations (community_id, created_by, token_hash, expires_at, max_uses)
  values (p_community_id, v_user, private.invitation_token_hash(v_token), now() + p_expires_in, p_max_uses)
  returning id, invitations.expires_at into v_id, v_exp;

  perform private.record_audit_event(p_community_id, 'invitation.created', 'invitation', v_id,
    jsonb_build_object('expires_at', v_exp, 'max_uses', p_max_uses));

  return query select v_id, v_token, v_exp, p_max_uses;
end;
$$;

create or replace function public.revoke_invitation(p_invitation_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations;
begin
  select * into v_inv from public.invitations i where i.id = p_invitation_id for update;
  if v_inv.id is null or not public.has_community_permission(v_inv.community_id, 'members.invite') then
    -- Same answer for "does not exist" and "not yours to see".
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  if v_inv.status = 'revoked' then
    return false;
  end if;
  update public.invitations
  set status = 'revoked', revoked_at = now(), revoked_by = private.current_active_user_id()
  where id = v_inv.id;
  perform private.record_audit_event(v_inv.community_id, 'invitation.revoked', 'invitation', v_inv.id,
    jsonb_build_object('use_count', v_inv.use_count, 'previous_status', v_inv.status));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Redeem (any authenticated user holding the token)
-- ---------------------------------------------------------------------------
create or replace function public.redeem_invitation(p_token text)
returns table (community_id uuid, membership_id uuid, membership_status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user       uuid := private.current_active_user_id();
  v_inv        public.invitations;
  v_membership public.memberships;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Lock the invitation: concurrent redemptions of the same invitation
  -- queue here and re-read the updated use_count.
  select * into v_inv from public.invitations i
  where i.token_hash = private.invitation_token_hash(p_token)
  for update;

  if v_inv.id is null then
    raise exception 'invalid invitation' using errcode = 'P0002';
  end if;
  if v_inv.status = 'revoked' then
    raise exception 'this invitation has been revoked' using errcode = '22023';
  end if;
  if v_inv.status = 'expired' or v_inv.expires_at <= now() then
    raise exception 'this invitation has expired' using errcode = '22023';
  end if;
  if v_inv.max_uses is not null and v_inv.use_count >= v_inv.max_uses then
    raise exception 'this invitation has reached its maximum number of uses' using errcode = '22023';
  end if;
  -- The invitation is only as good as its creator's current authority.
  if v_inv.created_by is null or v_inv.created_by not in (
    select private.community_members_with_permission(v_inv.community_id, 'members.invite')
  ) then
    raise exception 'this invitation is no longer valid' using errcode = '22023';
  end if;

  select * into v_membership from public.memberships m
  where m.community_id = v_inv.community_id and m.user_id = v_user
  for update;

  if v_membership.id is not null then
    if v_membership.status = 'active' then
      raise exception 'you are already a member of this community' using errcode = '23505';
    elsif v_membership.status = 'suspended' then
      raise exception 'your membership in this community is suspended' using errcode = '42501';
    end if;
    -- pending / rejected / left: the invitation admits the user. The Stage 3
    -- lifecycle trigger assigns the default role.
    update public.memberships set status = 'active' where id = v_membership.id
    returning * into v_membership;
  else
    -- Created pending, then admitted, so the lifecycle trigger assigns the
    -- default role exactly as for an approved application.
    insert into public.memberships (community_id, user_id, status)
    values (v_inv.community_id, v_user, 'pending')
    returning * into v_membership;
    update public.memberships set status = 'active' where id = v_membership.id
    returning * into v_membership;
  end if;

  insert into public.invitation_redemptions (invitation_id, community_id, user_id, membership_id)
  values (v_inv.id, v_inv.community_id, v_user, v_membership.id);

  update public.invitations
  set use_count = use_count + 1,
      status = case when max_uses is not null and use_count + 1 >= max_uses then 'expired' else status end
  where id = v_inv.id;

  perform private.record_audit_event(v_inv.community_id, 'invitation.redeemed', 'invitation', v_inv.id,
    jsonb_build_object('membership_id', v_membership.id, 'user_id', v_user));

  return query select v_inv.community_id, v_membership.id, v_membership.status;
end;
$$;

-- Marks time-expired invitations (housekeeping for listings). Redemption
-- never depends on it having run.
create or replace function public.expire_invitations()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with u as (
    update public.invitations set status = 'expired'
    where status = 'active' and expires_at <= now()
    returning 1
  )
  select count(*)::integer from u;
$$;

revoke all on function private.invitation_token_hash(text)            from public, anon, authenticated;
revoke all on function public.create_invitation(uuid, interval, integer) from public, anon, authenticated;
revoke all on function public.revoke_invitation(uuid)                 from public, anon, authenticated;
revoke all on function public.redeem_invitation(text)                 from public, anon, authenticated;
revoke all on function public.expire_invitations()                    from public, anon, authenticated;
grant execute on function public.create_invitation(uuid, interval, integer) to authenticated;
grant execute on function public.revoke_invitation(uuid)                 to authenticated;
grant execute on function public.redeem_invitation(text)                 to authenticated;
grant execute on function public.expire_invitations()                    to service_role;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on table public.invitations, public.invitation_redemptions from public, anon, authenticated;
grant all on table public.invitations, public.invitation_redemptions to service_role;
alter table public.invitations            enable row level security;
alter table public.invitation_redemptions enable row level security;

-- token_hash is deliberately NOT selectable by clients. No INSERT, UPDATE
-- or DELETE grants: create / revoke / redeem go through the functions.
grant select (id, community_id, created_by, expires_at, max_uses, use_count, status, revoked_at, revoked_by, created_at, updated_at)
  on public.invitations to authenticated;

create policy invitations_select_inviters on public.invitations
  for select to authenticated
  using (public.has_community_permission(community_id, 'members.invite'));

grant select on public.invitation_redemptions to authenticated;

create policy invitation_redemptions_select on public.invitation_redemptions
  for select to authenticated
  using (
    user_id = (select private.current_active_user_id())
    or public.has_community_permission(community_id, 'members.invite')
  );

-- Listing for inviters (explicit columns; token_hash never included).
create or replace function public.list_invitations(p_community_id uuid, p_include_inactive boolean default false)
returns table (
  id uuid, community_id uuid, created_by uuid, expires_at timestamptz, max_uses integer,
  use_count integer, status text, effective_status text, revoked_at timestamptz, created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select i.id, i.community_id, i.created_by, i.expires_at, i.max_uses, i.use_count, i.status,
         case when i.status = 'active' and i.expires_at <= now() then 'expired' else i.status end,
         i.revoked_at, i.created_at
  from public.invitations i
  where i.community_id = p_community_id
    and (p_include_inactive or (i.status = 'active' and i.expires_at > now()))
  order by i.created_at desc
  limit 200;
$$;

revoke all on function public.list_invitations(uuid, boolean) from public, anon, authenticated;
grant execute on function public.list_invitations(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Audit actions
-- ---------------------------------------------------------------------------
insert into public.audit_actions (action, entity_type, description) values
  ('invitation.created',  'invitation', 'An invitation was created'),
  ('invitation.revoked',  'invitation', 'An invitation was revoked'),
  ('invitation.redeemed', 'invitation', 'Someone joined through an invitation');
