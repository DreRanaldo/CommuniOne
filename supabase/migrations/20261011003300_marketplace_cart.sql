-- Marketplace Stage C / Migration 33: shopping cart (see docs/commerce/).
--
-- One cart per buyer per community (decision D1). Cart lines hold a listing
-- and a quantity ONLY: prices, stock and totals are always read from the
-- listings at the time they are shown (cart_quote) or bought (checkout,
-- Stage D). `seen_price_minor` is the price the buyer saw when adding, used
-- only to warn "the price changed"; it is never charged.
--
-- Products with a fixed price only: services are booked (Stage J).
-- Clients have no write grants: cart_set_item() / cart_clear() validate
-- every change (marketplace.buy, visible active listing of an active
-- seller, not your own, in stock, quantity 1-99).

create table public.carts (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint carts_community_user_key unique (community_id, user_id),
  constraint carts_id_community_key unique (id, community_id)
);

create table public.cart_items (
  cart_id          uuid not null,
  community_id     uuid not null,
  listing_id       uuid not null,
  quantity         integer not null check (quantity between 1 and 99),
  seen_price_minor bigint not null check (seen_price_minor >= 0),
  added_at         timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (cart_id, listing_id),
  constraint cart_items_cart_fkey foreign key (cart_id, community_id)
    references public.carts (id, community_id) on delete cascade,
  constraint cart_items_listing_fkey foreign key (listing_id, community_id)
    references public.listings (id, community_id) on delete cascade
);

create index cart_items_listing_idx on public.cart_items (listing_id);

create trigger carts_set_updated_at
  before update on public.carts
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Changing the cart
-- ---------------------------------------------------------------------------
-- Sets a line's quantity (0 removes it). Returns the new quantity.
create or replace function public.cart_set_item(p_listing_id uuid, p_quantity integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me        uuid := private.current_active_user_id();
  v_listing   public.listings;
  v_available integer;
  v_cart      uuid;
begin
  if v_me is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity < 0 or p_quantity > 99 then
    raise exception 'quantity must be between 0 and 99' using errcode = '22023';
  end if;
  select * into v_listing from public.listings l where l.id = p_listing_id;
  if v_listing.id is null
     or not private.can_view_listing_row(v_listing.community_id, v_listing.seller_user_id, v_listing.status, v_listing.seller_profile_id) then
    raise exception 'listing not found' using errcode = 'P0002';
  end if;
  if not public.has_community_permission(v_listing.community_id, 'marketplace.buy') then
    raise exception 'marketplace.buy is required in this community' using errcode = '42501';
  end if;

  if p_quantity = 0 then
    delete from public.cart_items ci
    using public.carts c
    where c.id = ci.cart_id and c.user_id = v_me and c.community_id = v_listing.community_id
      and ci.listing_id = p_listing_id;
    return 0;
  end if;

  if v_listing.seller_user_id = v_me then
    raise exception 'you cannot buy your own listing' using errcode = '22023';
  end if;
  if v_listing.kind <> 'product' or v_listing.pricing <> 'fixed' or v_listing.price_minor is null then
    raise exception 'services are booked, not added to the cart' using errcode = '22023';
  end if;
  if v_listing.status <> 'active'
     or not exists (select 1 from public.seller_profiles s where s.id = v_listing.seller_profile_id and s.status = 'active') then
    raise exception 'this listing is not for sale right now' using errcode = '22023';
  end if;
  select i.on_hand - i.reserved into v_available from public.inventory i where i.listing_id = p_listing_id;
  if coalesce(v_available, 0) < p_quantity then
    raise exception 'only % available', greatest(coalesce(v_available, 0), 0) using errcode = '22023';
  end if;

  insert into public.carts (community_id, user_id) values (v_listing.community_id, v_me)
  on conflict (community_id, user_id) do update set updated_at = now()
  returning id into v_cart;

  insert into public.cart_items (cart_id, community_id, listing_id, quantity, seen_price_minor)
  values (v_cart, v_listing.community_id, p_listing_id, p_quantity, v_listing.price_minor)
  on conflict (cart_id, listing_id) do update
    set quantity = excluded.quantity, seen_price_minor = excluded.seen_price_minor, updated_at = now();
  return p_quantity;
end;
$$;

create or replace function public.cart_clear(p_community_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.cart_items ci
  using public.carts c
  where c.id = ci.cart_id and c.user_id = (select private.current_active_user_id()) and c.community_id = p_community_id;
$$;

-- ---------------------------------------------------------------------------
-- The cart as the server prices it now
-- ---------------------------------------------------------------------------
-- issue: null (fine) | unavailable | out_of_stock | insufficient_stock | price_changed
-- line_total_minor and subtotal count only lines that can be bought.
create or replace function public.cart_quote(p_community_id uuid)
returns table (
  listing_id uuid, seller_profile_id uuid, seller_display_name text, title text, cover_image_path text,
  unit_price_minor bigint, seen_price_minor bigint, currency text, quantity integer, available integer,
  fulfillment text[], line_total_minor bigint, issue text, subtotal_minor bigint, item_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_active_user_id();
begin
  if v_me is null or not public.has_community_permission(p_community_id, 'marketplace.buy') then
    raise exception 'marketplace.buy is required in this community' using errcode = '42501';
  end if;
  return query
  with lines as (
    select ci.listing_id, l.seller_profile_id, s.display_name, l.title,
           (select li.storage_path from public.listing_images li where li.listing_id = l.id order by li.position limit 1) as cover,
           l.price_minor, ci.seen_price_minor, l.currency::text as currency, ci.quantity,
           greatest(coalesce(i.on_hand - i.reserved, 0), 0) as available, l.fulfillment,
           case
             when l.status <> 'active' or s.status <> 'active' or l.kind <> 'product' or l.price_minor is null
               or not private.can_view_listing_row(l.community_id, l.seller_user_id, l.status, l.seller_profile_id) then 'unavailable'
             when coalesce(i.on_hand - i.reserved, 0) <= 0 then 'out_of_stock'
             when coalesce(i.on_hand - i.reserved, 0) < ci.quantity then 'insufficient_stock'
             when l.price_minor <> ci.seen_price_minor then 'price_changed'
           end as issue,
           ci.added_at
    from public.carts c
    join public.cart_items ci on ci.cart_id = c.id
    join public.listings l on l.id = ci.listing_id
    join public.seller_profiles s on s.id = l.seller_profile_id
    left join public.inventory i on i.listing_id = l.id
    where c.user_id = v_me and c.community_id = p_community_id
  )
  select ln.listing_id, ln.seller_profile_id, ln.display_name, ln.title, ln.cover,
         ln.price_minor, ln.seen_price_minor, ln.currency, ln.quantity, ln.available, ln.fulfillment,
         case when ln.issue in ('unavailable', 'out_of_stock', 'insufficient_stock') then 0::bigint
              else ln.price_minor * ln.quantity end,
         ln.issue,
         coalesce(sum(case when ln.issue in ('unavailable', 'out_of_stock', 'insufficient_stock') then 0::bigint
                           else ln.price_minor * ln.quantity end) over (), 0)::bigint,
         coalesce(sum(ln.quantity) over (), 0)::integer
  from lines ln
  order by ln.display_name, ln.added_at;
end;
$$;

revoke all on function public.cart_set_item(uuid, integer) from public, anon, authenticated;
revoke all on function public.cart_clear(uuid)             from public, anon, authenticated;
revoke all on function public.cart_quote(uuid)             from public, anon, authenticated;
grant execute on function public.cart_set_item(uuid, integer) to authenticated;
grant execute on function public.cart_clear(uuid)             to authenticated;
grant execute on function public.cart_quote(uuid)             to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges and RLS: read your own cart; write only through the functions.
-- ---------------------------------------------------------------------------
revoke all on table public.carts, public.cart_items from public, anon, authenticated;
grant all on table public.carts, public.cart_items to service_role;
alter table public.carts      enable row level security;
alter table public.cart_items enable row level security;

grant select on public.carts, public.cart_items to authenticated;
create policy carts_select_own on public.carts
  for select to authenticated using (user_id = (select private.current_active_user_id()));
create policy cart_items_select_own on public.cart_items
  for select to authenticated
  using (exists (select 1 from public.carts c where c.id = cart_id and c.user_id = (select private.current_active_user_id())));
