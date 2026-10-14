-- Marketplace Stage B / Migration 32: catalog (see docs/commerce/).
--
-- Decision D1 (owner): the marketplace is PER COMMUNITY. Listings, seller
-- profiles, stock and favorites belong to one community; only its active
-- members with the right permission see, sell or save them.
--
--   permissions        marketplace.view / buy / sell / manage (+ templates
--                      and every existing community's system roles)
--   market_categories  platform-wide, seeded (products and services)
--   seller_profiles    one per seller per community
--   listings           products and services (extensible: kind + pricing)
--   listing_images     private `listing-images` bucket, own-folder uploads
--   inventory          stock per product listing; reserved stays 0 until
--                      checkout (Stage D) reserves it; available = on_hand - reserved
--   inventory_movements append-only stock history
--   favorites          a member's saved listings (owner-only)
--   search_listings()  search, filter, sort, paging for the storefront
--   set_listing_stock() the only way to change stock
--
-- Money: bigint minor units (JMD cents); JMD only for now (decision D10).
-- No cart, checkout or payment here (Stages C-E).

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (key, module, description) values
  ('marketplace.view',   'marketplace', 'Browse the community marketplace'),
  ('marketplace.buy',    'marketplace', 'Buy in the community marketplace'),
  ('marketplace.sell',   'marketplace', 'Sell products and services in the community marketplace'),
  ('marketplace.manage', 'marketplace', 'Moderate marketplace listings and sellers')
on conflict (key) do nothing;

-- Templates: Members and Moderators view, buy and sell; Admins and Owners
-- also manage (the Admin template is "everything except roles.manage").
insert into public.role_template_permissions (template_id, permission_id)
select t.id, p.id
from public.role_templates t
join public.permissions p on p.key in ('marketplace.view', 'marketplace.buy', 'marketplace.sell')
                          or (p.key = 'marketplace.manage' and t.key in ('owner', 'admin'))
where t.key in ('owner', 'admin', 'moderator', 'member')
on conflict do nothing;

-- Existing communities: system roles copied from those templates (same name).
insert into public.role_permissions (role_id, permission_id)
select r.id, tp.permission_id
from public.roles r
join public.role_templates t on t.name = r.name
join public.role_template_permissions tp on tp.template_id = t.id
join public.permissions p on p.id = tp.permission_id and p.module = 'marketplace'
where r.is_system_role
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Categories (platform-wide)
-- ---------------------------------------------------------------------------
create table public.market_categories (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references public.market_categories (id) on delete restrict,
  slug       text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  kind       text not null check (kind in ('product', 'service')),
  icon       text,
  sort_order integer not null default 0,
  active     boolean not null default true
);

comment on table public.market_categories is 'Marketplace categories (platform-wide, managed by migration).';

insert into public.market_categories (slug, name, kind, icon, sort_order) values
  ('electronics',        'Electronics',              'product', 'tv-outline',             10),
  ('phones',             'Phones & accessories',     'product', 'phone-portrait-outline', 20),
  ('home-garden',        'Home & garden',            'product', 'leaf-outline',           30),
  ('furniture',          'Furniture',                'product', 'bed-outline',            40),
  ('appliances',         'Appliances',               'product', 'cube-outline',           50),
  ('fashion',            'Fashion & clothing',       'product', 'shirt-outline',          60),
  ('health-beauty',      'Health & beauty',          'product', 'flower-outline',         70),
  ('baby-kids',          'Baby & kids',              'product', 'happy-outline',          80),
  ('sports-outdoors',    'Sports & outdoors',        'product', 'football-outline',       90),
  ('vehicles-parts',     'Vehicles & parts',         'product', 'car-outline',           100),
  ('books-media',        'Books & media',            'product', 'book-outline',          110),
  ('food-drink',         'Food & drink',             'product', 'restaurant-outline',    120),
  ('arts-crafts',        'Arts & crafts',            'product', 'color-palette-outline', 130),
  ('pets',               'Pets & supplies',          'product', 'paw-outline',           140),
  ('other-products',     'Other items',              'product', 'pricetag-outline',      150),
  ('home-repair',        'Home repair & maintenance', 'service', 'hammer-outline',        210),
  ('cleaning',           'Cleaning',                 'service', 'sparkles-outline',      220),
  ('beauty-care',        'Beauty & personal care',   'service', 'cut-outline',           230),
  ('lessons',            'Tutoring & lessons',       'service', 'school-outline',        240),
  ('care',               'Childcare & eldercare',    'service', 'heart-outline',         250),
  ('transport-errands',  'Transport & errands',      'service', 'bicycle-outline',       260),
  ('events-catering',    'Events & catering',        'service', 'balloon-outline',       270),
  ('tech-help',          'Tech help',                'service', 'laptop-outline',        280),
  ('fitness-wellness',   'Fitness & wellness',       'service', 'barbell-outline',       290),
  ('professional',       'Professional services',    'service', 'briefcase-outline',     300),
  ('other-services',     'Other services',           'service', 'construct-outline',     310);

-- ---------------------------------------------------------------------------
-- Seller profiles
-- ---------------------------------------------------------------------------
create table public.seller_profiles (
  id                  uuid primary key default gen_random_uuid(),
  community_id        uuid not null references public.communities (id) on delete restrict,
  user_id             uuid not null references public.profiles (id) on delete cascade,
  display_name        text not null check (char_length(btrim(display_name)) between 1 and 80),
  bio                 text check (char_length(bio) <= 1000),
  status              text not null default 'active' check (status in ('active', 'paused', 'suspended')),
  -- Set by platform operators only (decision D8); never by clients.
  verification_status text not null default 'unverified'
                      check (verification_status in ('unverified', 'pending', 'verified', 'rejected')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint seller_profiles_community_user_key unique (community_id, user_id),
  constraint seller_profiles_id_community_key unique (id, community_id)
);

create trigger seller_profiles_set_updated_at
  before update on public.seller_profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Listings
-- ---------------------------------------------------------------------------
create table public.listings (
  id                uuid primary key default gen_random_uuid(),
  community_id      uuid not null references public.communities (id) on delete restrict,
  seller_profile_id uuid not null,
  seller_user_id    uuid not null references public.profiles (id) on delete cascade,
  kind              text not null check (kind in ('product', 'service')),
  category_id       uuid not null references public.market_categories (id) on delete restrict,
  title             text not null check (char_length(btrim(title)) between 3 and 120),
  description       text not null default '' check (char_length(description) <= 5000),
  -- Products: new / like_new / good / fair. Services: none.
  condition         text check (condition in ('new', 'like_new', 'good', 'fair')),
  -- fixed: price per item (products) or per job; hourly: per hour; quote: price on request.
  pricing           text not null default 'fixed' check (pricing in ('fixed', 'hourly', 'quote')),
  price_minor       bigint check (price_minor between 0 and 1000000000000),
  currency          char(3) not null default 'JMD' check (currency = 'JMD'),
  fulfillment       text[] not null default '{}'::text[],
  pickup_area       text check (char_length(pickup_area) <= 120),
  service_area      text check (char_length(service_area) <= 200),
  status            text not null default 'draft' check (status in ('draft', 'active', 'paused', 'removed')),
  removed_by        uuid references public.profiles (id) on delete set null,
  removal_reason    text check (char_length(removal_reason) <= 500),
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search            tsvector generated always as (
                      setweight(to_tsvector('english', coalesce(title, '')), 'A')
                      || setweight(to_tsvector('english', coalesce(description, '')), 'B')
                    ) stored,
  constraint listings_seller_profile_fkey foreign key (seller_profile_id, community_id)
    references public.seller_profiles (id, community_id) on delete cascade,
  constraint listings_id_community_key unique (id, community_id),
  constraint listings_product_rules check (
    kind = 'service' or (pricing = 'fixed' and condition is not null and cardinality(fulfillment) >= 1)
  ),
  constraint listings_service_rules check (kind = 'product' or condition is null),
  constraint listings_price_rules check ((pricing = 'quote') = (price_minor is null)),
  constraint listings_fulfillment_values check (fulfillment <@ array['pickup', 'seller_delivery']::text[])
);

comment on table public.listings is
  'Marketplace listings (products and services) of one community. See docs/commerce/data-model.md.';

create index listings_storefront_idx on public.listings (community_id, status, published_at desc);
create index listings_category_idx on public.listings (community_id, category_id);
create index listings_seller_idx on public.listings (seller_profile_id);
create index listings_search_idx on public.listings using gin (search);

create trigger listings_set_updated_at
  before update on public.listings
  for each row execute function private.set_updated_at();

create trigger listings_rate_limit
  before insert on public.listings
  for each row execute function private.rate_limit_trigger('listing.create');

insert into private.rate_limit_rules (action, max_count, window_seconds, description) values
  ('listing.create', 30, 3600, 'Marketplace listings created per user per hour')
on conflict (action) do nothing;

-- ---------------------------------------------------------------------------
-- Visibility helpers
-- ---------------------------------------------------------------------------
-- Sellers see their own listings (any status); managers see everything but
-- drafts; members see active listings of active sellers.
create or replace function private.can_view_listing_row(
  p_community_id uuid, p_seller_user_id uuid, p_status text, p_seller_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_seller_user_id = (select private.current_active_user_id()) then
      public.has_community_permission(p_community_id, 'marketplace.view')
      or public.has_community_permission(p_community_id, 'marketplace.sell')
    when public.has_community_permission(p_community_id, 'marketplace.manage') then
      p_status <> 'draft'
    else
      p_status = 'active'
      and public.has_community_permission(p_community_id, 'marketplace.view')
      and exists (select 1 from public.seller_profiles s where s.id = p_seller_profile_id and s.status = 'active')
  end;
$$;

create or replace function private.can_view_listing_id(p_listing_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.listings l
    where l.id = p_listing_id
      and private.can_view_listing_row(l.community_id, l.seller_user_id, l.status, l.seller_profile_id)
  );
$$;

-- The listing's seller, still allowed to sell in its community.
create or replace function private.is_listing_seller(p_listing_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.listings l
    where l.id = p_listing_id
      and l.seller_user_id = (select private.current_active_user_id())
      and public.has_community_permission(l.community_id, 'marketplace.sell')
  );
$$;

revoke all on function private.can_view_listing_row(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.can_view_listing_id(uuid)                   from public, anon, authenticated;
revoke all on function private.is_listing_seller(uuid)                     from public, anon, authenticated;
grant execute on function private.can_view_listing_row(uuid, uuid, text, uuid) to authenticated;
grant execute on function private.can_view_listing_id(uuid)                   to authenticated;
grant execute on function private.is_listing_seller(uuid)                     to authenticated;

-- ---------------------------------------------------------------------------
-- Write enforcement (who: RLS; what may change: these triggers)
-- ---------------------------------------------------------------------------
create or replace function private.enforce_seller_profile_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := case when current_user in ('authenticated', 'anon') then private.current_active_user_id() end;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.user_id := v_me;
    new.status := 'active';
    new.verification_status := 'unverified';
    return new;
  end if;
  if (new.community_id, new.user_id, new.verification_status, new.created_at)
     is distinct from (old.community_id, old.user_id, old.verification_status, old.created_at) then
    raise exception 'only the seller''s name, description and status can be changed' using errcode = '42501';
  end if;
  if old.user_id = v_me then
    -- The seller pauses or resumes; a suspension is lifted only by a manager.
    if new.status is distinct from old.status
       and (old.status = 'suspended' or new.status not in ('active', 'paused')) then
      raise exception 'a suspended seller profile can only be reinstated by a marketplace manager' using errcode = '42501';
    end if;
    return new;
  end if;
  -- A marketplace manager: suspend or reinstate only.
  if (new.display_name, new.bio) is distinct from (old.display_name, old.bio)
     or not ((old.status <> 'suspended' and new.status = 'suspended')
             or (old.status = 'suspended' and new.status = 'active')) then
    raise exception 'marketplace managers can only suspend or reinstate a seller' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_seller_profile_write() from public, anon, authenticated;

create trigger seller_profiles_enforce_write
  before insert or update on public.seller_profiles
  for each row execute function private.enforce_seller_profile_write();

create or replace function private.enforce_listing_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_me     uuid := case when current_user in ('authenticated', 'anon') then private.current_active_user_id() end;
  v_seller public.seller_profiles;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    select * into v_seller from public.seller_profiles s where s.id = new.seller_profile_id;
    if v_seller.user_id is distinct from v_me or v_seller.community_id is distinct from new.community_id then
      raise exception 'listings are created under your own seller profile in that community' using errcode = '42501';
    end if;
    if v_seller.status <> 'active' then
      raise exception 'your seller profile is %', v_seller.status using errcode = '42501';
    end if;
    if new.status not in ('draft', 'active') then
      raise exception 'new listings are drafts or active' using errcode = '22023';
    end if;
    if not exists (select 1 from public.market_categories c where c.id = new.category_id and c.kind = new.kind and c.active) then
      raise exception 'choose a % category', new.kind using errcode = '22023';
    end if;
    new.seller_user_id := v_me;
    new.removed_by := null;
    new.removal_reason := null;
    new.published_at := case when new.status = 'active' then now() end;
    return new;
  end if;

  -- UPDATE ------------------------------------------------------------------
  if (new.community_id, new.seller_profile_id, new.seller_user_id, new.kind, new.created_at)
     is distinct from (old.community_id, old.seller_profile_id, old.seller_user_id, old.kind, old.created_at) then
    raise exception 'a listing''s community, seller and kind cannot change' using errcode = '42501';
  end if;
  if old.status = 'removed' then
    raise exception 'removed listings cannot be changed' using errcode = '42501';
  end if;

  if old.seller_user_id = v_me then
    if new.removed_by is distinct from old.removed_by or new.removal_reason is distinct from old.removal_reason then
      raise exception 'only moderators record a removal reason' using errcode = '42501';
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'draft'  and new.status in ('active', 'removed'))
      or (old.status = 'active' and new.status in ('paused', 'removed'))
      or (old.status = 'paused' and new.status in ('active', 'removed'))
    ) then
      raise exception 'invalid listing status change: % -> %', old.status, new.status using errcode = '22023';
    end if;
    if new.status = 'active' and old.status <> 'active' then
      if not exists (select 1 from public.seller_profiles s where s.id = new.seller_profile_id and s.status = 'active') then
        raise exception 'your seller profile is not active' using errcode = '42501';
      end if;
    end if;
    if new.category_id is distinct from old.category_id
       and not exists (select 1 from public.market_categories c where c.id = new.category_id and c.kind = new.kind and c.active) then
      raise exception 'choose a % category', new.kind using errcode = '22023';
    end if;
    if new.status = 'removed' then
      new.removed_by := v_me;
    end if;
    new.published_at := coalesce(old.published_at, case when new.status = 'active' then now() end);
    return new;
  end if;

  -- A marketplace manager: remove (with a reason), nothing else.
  if new.status <> 'removed'
     or (new.title, new.description, new.price_minor, new.pricing, new.condition, new.category_id,
         new.fulfillment, new.pickup_area, new.service_area, new.published_at)
        is distinct from
        (old.title, old.description, old.price_minor, old.pricing, old.condition, old.category_id,
         old.fulfillment, old.pickup_area, old.service_area, old.published_at) then
    raise exception 'marketplace managers can only remove a listing' using errcode = '42501';
  end if;
  if new.removal_reason is null or char_length(btrim(new.removal_reason)) = 0 then
    raise exception 'give a reason for removing this listing' using errcode = '22023';
  end if;
  new.removed_by := v_me;
  return new;
end;
$$;

revoke all on function private.enforce_listing_write() from public, anon, authenticated;

create trigger listings_enforce_write
  before insert or update on public.listings
  for each row execute function private.enforce_listing_write();

-- Moderation is audited (AFTER triggers; SECURITY DEFINER to write the log).
create or replace function private.audit_marketplace_moderation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'listings' then
    if new.status = 'removed' and old.status <> 'removed' and new.removed_by is distinct from new.seller_user_id then
      perform private.record_audit_event(new.community_id, 'listing.removed', 'listing', new.id,
        jsonb_build_object('reason', new.removal_reason));
    end if;
  elsif new.status is distinct from old.status and (new.status = 'suspended' or old.status = 'suspended') then
    perform private.record_audit_event(new.community_id,
      case when new.status = 'suspended' then 'seller.suspended' else 'seller.reinstated' end,
      'seller_profile', new.id, '{}'::jsonb);
  end if;
  return null;
end;
$$;

revoke all on function private.audit_marketplace_moderation() from public, anon, authenticated;

create trigger listings_audit_moderation
  after update of status on public.listings
  for each row execute function private.audit_marketplace_moderation();

create trigger seller_profiles_audit_moderation
  after update of status on public.seller_profiles
  for each row execute function private.audit_marketplace_moderation();

-- ---------------------------------------------------------------------------
-- Images (private bucket, same layout as post-images)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-images', 'listing-images', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table public.listing_images (
  id           uuid primary key default gen_random_uuid(),
  listing_id   uuid not null,
  community_id uuid not null,
  storage_path text not null unique
               check (storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'),
  position     smallint not null check (position between 0 and 9),
  width        integer not null check (width between 1 and 20000),
  height       integer not null check (height between 1 and 20000),
  created_at   timestamptz not null default now(),
  constraint listing_images_listing_fkey foreign key (listing_id, community_id)
    references public.listings (id, community_id) on delete cascade,
  constraint listing_images_listing_position_key unique (listing_id, position)
);

create or replace function private.check_listing_image()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_folder record;
  v_seller uuid;
begin
  select l.seller_user_id into v_seller from public.listings l where l.id = new.listing_id;
  select * into v_folder from private.post_image_folder(new.storage_path);
  if v_folder.community_id is distinct from new.community_id or v_folder.user_id is distinct from v_seller then
    raise exception 'the picture must be the seller''s own upload for this community' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'listing-images' and o.name = new.storage_path) then
    raise exception 'the picture was not uploaded' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.check_listing_image() from public, anon, authenticated;

create trigger listing_images_check
  before insert on public.listing_images
  for each row execute function private.check_listing_image();

create or replace function private.can_upload_listing_image_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select f.user_id is not null
     and f.user_id = (select private.current_active_user_id())
     and public.has_community_permission(f.community_id, 'marketplace.sell')
  from private.post_image_folder(p_name) f;
$$;

create or replace function private.can_read_listing_image_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from public.listing_images li
      join public.listings l on l.id = li.listing_id
      where li.storage_path = p_name
        and private.can_view_listing_row(l.community_id, l.seller_user_id, l.status, l.seller_profile_id)
    )
    or (select f.user_id is not null and f.user_id = (select private.current_active_user_id())
        from private.post_image_folder(p_name) f);
$$;

create or replace function private.can_delete_listing_image_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select f.user_id is not null and f.user_id = (select private.current_active_user_id())
          from private.post_image_folder(p_name) f)
     and not exists (select 1 from public.listing_images li where li.storage_path = p_name);
$$;

revoke all on function private.can_upload_listing_image_object(text) from public, anon, authenticated;
revoke all on function private.can_read_listing_image_object(text)   from public, anon, authenticated;
revoke all on function private.can_delete_listing_image_object(text) from public, anon, authenticated;
grant execute on function private.can_upload_listing_image_object(text) to authenticated;
grant execute on function private.can_read_listing_image_object(text)   to authenticated;
grant execute on function private.can_delete_listing_image_object(text) to authenticated;

create policy listing_images_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'listing-images' and private.can_read_listing_image_object(name));

create policy listing_images_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'listing-images' and private.can_upload_listing_image_object(name));

create policy listing_images_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'listing-images' and private.can_delete_listing_image_object(name));

-- Pictures no listing uses any more (removed from a listing, failed saves):
-- for a scheduled cleanup job (service role).
create or replace function public.list_listing_image_files_to_purge(p_grace interval default interval '1 day')
returns table (name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name from storage.objects o
  where o.bucket_id = 'listing-images'
    and o.created_at < now() - p_grace
    and not exists (select 1 from public.listing_images li where li.storage_path = o.name)
  order by o.created_at
  limit 1000;
$$;

revoke all on function public.list_listing_image_files_to_purge(interval) from public, anon, authenticated;
grant execute on function public.list_listing_image_files_to_purge(interval) to service_role;

-- ---------------------------------------------------------------------------
-- Inventory (products)
-- ---------------------------------------------------------------------------
create table public.inventory (
  listing_id   uuid primary key,
  community_id uuid not null,
  on_hand      integer not null default 0 check (on_hand between 0 and 1000000),
  -- Held by checkouts in progress (Stage D). Always 0 until then.
  reserved     integer not null default 0 check (reserved >= 0),
  updated_at   timestamptz not null default now(),
  constraint inventory_reserved_within_stock check (reserved <= on_hand),
  constraint inventory_listing_fkey foreign key (listing_id, community_id)
    references public.listings (id, community_id) on delete cascade
);

create table public.inventory_movements (
  id           uuid primary key default gen_random_uuid(),
  listing_id   uuid not null references public.inventory (listing_id) on delete cascade,
  community_id uuid not null,
  delta        integer not null,
  on_hand_after integer not null check (on_hand_after >= 0),
  reason       text not null check (reason in ('initial', 'restock', 'adjustment', 'sale', 'reservation_release', 'return')),
  note         text check (char_length(note) <= 200),
  actor_user_id uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index inventory_movements_listing_idx on public.inventory_movements (listing_id, created_at desc);

create or replace function private.create_inventory_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'product' then
    insert into public.inventory (listing_id, community_id) values (new.id, new.community_id);
  end if;
  return null;
end;
$$;

revoke all on function private.create_inventory_row() from public, anon, authenticated;

create trigger listings_create_inventory
  after insert on public.listings
  for each row execute function private.create_inventory_row();

-- Inventory movements are a record: never rewritten.
create or replace function private.forbid_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows cannot be changed or deleted', tg_table_name using errcode = '42501';
end;
$$;

revoke all on function private.forbid_change() from public, anon, authenticated;

create trigger inventory_movements_append_only
  before update or delete on public.inventory_movements
  for each row execute function private.forbid_change();

-- The only way to change stock: the listing's seller sets the quantity on
-- hand (never below what checkouts have reserved). Recorded and audited.
create or replace function public.set_listing_stock(p_listing_id uuid, p_on_hand integer, p_note text default null)
returns table (listing_id uuid, on_hand integer, reserved integer, available integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_listing public.listings;
  v_inv     public.inventory;
begin
  select * into v_listing from public.listings l where l.id = p_listing_id;
  if v_listing.id is null or not private.is_listing_seller(p_listing_id) then
    raise exception 'listing not found' using errcode = 'P0002';
  end if;
  if v_listing.kind <> 'product' then
    raise exception 'only products have stock' using errcode = '22023';
  end if;
  if v_listing.status = 'removed' then
    raise exception 'removed listings cannot be changed' using errcode = '42501';
  end if;
  if p_on_hand is null or p_on_hand < 0 or p_on_hand > 1000000 then
    raise exception 'stock must be between 0 and 1000000' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 200 then
    raise exception 'the note can be at most 200 characters' using errcode = '22023';
  end if;

  select * into v_inv from public.inventory i where i.listing_id = p_listing_id for update;
  if p_on_hand < v_inv.reserved then
    raise exception 'stock cannot go below the % reserved by orders in progress', v_inv.reserved using errcode = '22023';
  end if;
  if p_on_hand <> v_inv.on_hand then
    update public.inventory i set on_hand = p_on_hand, updated_at = now() where i.listing_id = p_listing_id;
    insert into public.inventory_movements (listing_id, community_id, delta, on_hand_after, reason, note, actor_user_id)
    values (p_listing_id, v_listing.community_id, p_on_hand - v_inv.on_hand, p_on_hand,
            case when v_inv.on_hand = 0 and not exists (select 1 from public.inventory_movements m where m.listing_id = p_listing_id)
                 then 'initial' when p_on_hand > v_inv.on_hand then 'restock' else 'adjustment' end,
            nullif(btrim(p_note), ''), private.current_active_user_id());
    perform private.record_audit_event(v_listing.community_id, 'inventory.adjusted', 'listing', p_listing_id,
      jsonb_build_object('from', v_inv.on_hand, 'to', p_on_hand));
  end if;
  return query select p_listing_id, p_on_hand, v_inv.reserved, p_on_hand - v_inv.reserved;
end;
$$;

revoke all on function public.set_listing_stock(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.set_listing_stock(uuid, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Favorites
-- ---------------------------------------------------------------------------
create table public.favorites (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  listing_id   uuid not null,
  community_id uuid not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, listing_id),
  constraint favorites_listing_fkey foreign key (listing_id, community_id)
    references public.listings (id, community_id) on delete cascade
);

create index favorites_user_idx on public.favorites (user_id, community_id, created_at desc);

create or replace function private.set_favorite_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- SECURITY DEFINER (current_user is the owner here): the session user, if any, owns it.
  new.user_id := coalesce(private.current_active_user_id(), new.user_id);
  select l.community_id into new.community_id from public.listings l where l.id = new.listing_id;
  return new;
end;
$$;

revoke all on function private.set_favorite_owner() from public, anon, authenticated;

create trigger favorites_set_owner
  before insert on public.favorites
  for each row execute function private.set_favorite_owner();

-- ---------------------------------------------------------------------------
-- Storefront search (only active listings of active sellers)
-- ---------------------------------------------------------------------------
create or replace function public.search_listings(
  p_community_id      uuid,
  p_query             text    default null,
  p_category_id       uuid    default null,
  p_kind              text    default null,
  p_condition         text    default null,
  p_min_price_minor   bigint  default null,
  p_max_price_minor   bigint  default null,
  p_in_stock_only     boolean default false,
  p_seller_profile_id uuid    default null,
  p_favorites_only    boolean default false,
  p_sort              text    default 'newest',
  p_limit             integer default 24,
  p_offset            integer default 0
)
returns table (
  id uuid, community_id uuid, seller_profile_id uuid, seller_display_name text, seller_verified boolean,
  kind text, category_id uuid, category_name text, title text, condition text, pricing text,
  price_minor bigint, currency text, available integer, cover_image_path text, image_count integer,
  is_favorite boolean, published_at timestamptz, rank real
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me    uuid := private.current_active_user_id();
  v_query text := nullif(btrim(p_query), '');
  v_ts    tsquery;
  v_like  text;
begin
  if v_me is null or not public.has_community_permission(p_community_id, 'marketplace.view') then
    raise exception 'marketplace.view is required in this community' using errcode = '42501';
  end if;
  if v_query is not null and char_length(v_query) > 100 then
    raise exception 'search text can be at most 100 characters' using errcode = '22023';
  end if;
  if p_sort not in ('newest', 'price_asc', 'price_desc', 'relevance') then
    raise exception 'unknown sort order' using errcode = '22023';
  end if;
  if p_kind is not null and p_kind not in ('product', 'service') then
    raise exception 'unknown listing kind' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 50 or p_offset is null or p_offset not between 0 and 1000 then
    raise exception 'limit must be 1-50 and offset 0-1000' using errcode = '22023';
  end if;
  if v_query is not null then
    v_ts := websearch_to_tsquery('english', v_query);
    -- Literal substring match on the title too (partial words); wildcards escaped.
    v_like := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select l.id, l.community_id, l.seller_profile_id, s.display_name, s.verification_status = 'verified',
         l.kind, l.category_id, c.name, l.title, l.condition, l.pricing,
         l.price_minor, l.currency::text,
         case when l.kind = 'product' then i.on_hand - i.reserved end,
         (select li.storage_path from public.listing_images li where li.listing_id = l.id order by li.position limit 1),
         (select count(*)::integer from public.listing_images li where li.listing_id = l.id),
         exists (select 1 from public.favorites f where f.user_id = v_me and f.listing_id = l.id),
         l.published_at,
         case when v_ts is null then 0::real else ts_rank(l.search, v_ts) end
  from public.listings l
  join public.seller_profiles s on s.id = l.seller_profile_id
  join public.market_categories c on c.id = l.category_id
  left join public.inventory i on i.listing_id = l.id
  where l.community_id = p_community_id
    and l.status = 'active'
    and s.status = 'active'
    and (v_query is null or l.search @@ v_ts or l.title ilike v_like)
    and (p_category_id is null or l.category_id = p_category_id)
    and (p_kind is null or l.kind = p_kind)
    and (p_condition is null or l.condition = p_condition)
    and (p_min_price_minor is null or l.price_minor >= p_min_price_minor)
    and (p_max_price_minor is null or l.price_minor <= p_max_price_minor)
    and (not coalesce(p_in_stock_only, false) or l.kind = 'service' or i.on_hand - i.reserved > 0)
    and (p_seller_profile_id is null or l.seller_profile_id = p_seller_profile_id)
    and (not coalesce(p_favorites_only, false)
         or exists (select 1 from public.favorites f where f.user_id = v_me and f.listing_id = l.id))
  order by
    case when p_sort = 'relevance' and v_ts is not null then ts_rank(l.search, v_ts) end desc nulls last,
    case when p_sort = 'price_asc' then l.price_minor end asc nulls last,
    case when p_sort = 'price_desc' then l.price_minor end desc nulls last,
    l.published_at desc, l.id
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.search_listings(uuid, text, uuid, text, text, bigint, bigint, boolean, uuid, boolean, text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_listings(uuid, text, uuid, text, text, bigint, bigint, boolean, uuid, boolean, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on table public.market_categories, public.seller_profiles, public.listings, public.listing_images,
  public.inventory, public.inventory_movements, public.favorites from public, anon, authenticated;
grant all on table public.market_categories, public.seller_profiles, public.listings, public.listing_images,
  public.inventory, public.inventory_movements, public.favorites to service_role;

alter table public.market_categories   enable row level security;
alter table public.seller_profiles     enable row level security;
alter table public.listings            enable row level security;
alter table public.listing_images      enable row level security;
alter table public.inventory           enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.favorites           enable row level security;

-- Categories: readable by any signed-in user; changed by migration only.
grant select on public.market_categories to authenticated;
create policy market_categories_select on public.market_categories
  for select to authenticated using (active);

-- Seller profiles
grant select on public.seller_profiles to authenticated;
grant insert (community_id, display_name, bio) on public.seller_profiles to authenticated;
grant update (display_name, bio, status) on public.seller_profiles to authenticated;

create policy seller_profiles_select on public.seller_profiles
  for select to authenticated
  using (
    user_id = (select private.current_active_user_id())
    or public.has_community_permission(community_id, 'marketplace.manage')
    or (status = 'active' and public.has_community_permission(community_id, 'marketplace.view'))
  );

create policy seller_profiles_insert on public.seller_profiles
  for insert to authenticated
  with check (public.has_community_permission(community_id, 'marketplace.sell'));

create policy seller_profiles_update on public.seller_profiles
  for update to authenticated
  using (
    (user_id = (select private.current_active_user_id()) and public.has_community_permission(community_id, 'marketplace.sell'))
    or public.has_community_permission(community_id, 'marketplace.manage')
  )
  with check (
    (user_id = (select private.current_active_user_id()) and public.has_community_permission(community_id, 'marketplace.sell'))
    or public.has_community_permission(community_id, 'marketplace.manage')
  );

-- Listings
grant select on public.listings to authenticated;
grant insert (community_id, seller_profile_id, kind, category_id, title, description, condition, pricing,
              price_minor, fulfillment, pickup_area, service_area, status) on public.listings to authenticated;
grant update (category_id, title, description, condition, pricing, price_minor, fulfillment, pickup_area,
              service_area, status, removal_reason) on public.listings to authenticated;

create policy listings_select on public.listings
  for select to authenticated
  using (private.can_view_listing_row(community_id, seller_user_id, status, seller_profile_id));

create policy listings_insert on public.listings
  for insert to authenticated
  with check (public.has_community_permission(community_id, 'marketplace.sell'));

create policy listings_update on public.listings
  for update to authenticated
  using (
    (seller_user_id = (select private.current_active_user_id()) and public.has_community_permission(community_id, 'marketplace.sell'))
    or (status <> 'draft' and public.has_community_permission(community_id, 'marketplace.manage'))
  )
  with check (
    (seller_user_id = (select private.current_active_user_id()) and public.has_community_permission(community_id, 'marketplace.sell'))
    or public.has_community_permission(community_id, 'marketplace.manage')
  );

-- Listing images: the seller adds and removes; readers follow the listing.
grant select on public.listing_images to authenticated;
grant insert (listing_id, community_id, storage_path, position, width, height) on public.listing_images to authenticated;
grant delete on public.listing_images to authenticated;

create policy listing_images_select on public.listing_images
  for select to authenticated using (private.can_view_listing_id(listing_id));
create policy listing_images_insert on public.listing_images
  for insert to authenticated with check (private.is_listing_seller(listing_id));
create policy listing_images_delete on public.listing_images
  for delete to authenticated using (private.is_listing_seller(listing_id));

-- Inventory: readable with the listing; written by set_listing_stock() only.
grant select on public.inventory to authenticated;
create policy inventory_select on public.inventory
  for select to authenticated using (private.can_view_listing_id(listing_id));

grant select on public.inventory_movements to authenticated;
create policy inventory_movements_select on public.inventory_movements
  for select to authenticated using (private.is_listing_seller(listing_id));

-- Favorites: your own, on listings you can see.
grant select, delete on public.favorites to authenticated;
grant insert (listing_id) on public.favorites to authenticated;
create policy favorites_select on public.favorites
  for select to authenticated using (user_id = (select private.current_active_user_id()));
create policy favorites_insert on public.favorites
  for insert to authenticated
  with check (user_id = (select private.current_active_user_id()) and private.can_view_listing_id(listing_id));
create policy favorites_delete on public.favorites
  for delete to authenticated using (user_id = (select private.current_active_user_id()));

-- ---------------------------------------------------------------------------
-- Audit actions
-- ---------------------------------------------------------------------------
insert into public.audit_actions (action, entity_type, description) values
  ('listing.removed',    'listing',        'A marketplace manager removed a listing'),
  ('inventory.adjusted', 'listing',        'A seller changed the stock of a listing'),
  ('seller.suspended',   'seller_profile', 'A marketplace manager suspended a seller'),
  ('seller.reinstated',  'seller_profile', 'A marketplace manager reinstated a seller')
on conflict (action) do nothing;
