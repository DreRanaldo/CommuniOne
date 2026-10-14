-- Marketplace Stage D / Migration 34: addresses, delivery options, tax,
-- checkout and orders (see docs/commerce/).
--
--   addresses            the buyer's own (owner-only, like profile_private)
--   delivery_options     one per shop: seller delivery fee, parishes, estimate
--   tax_rates            GCT (decision D9: owner/accountant to confirm);
--                        charged only by sellers who say they are GCT-registered
--   checkouts            the buyer's parent record; immutable totals
--   orders               one per seller per checkout; address/contact snapshots
--   order_items          purchase-time snapshots (title, price, quantity)
--   order_events         append-only status history
--   inventory_reservations stock held while payment is pending
--
-- checkout_preview() and checkout_create() price EVERYTHING on the server
-- (prices, delivery fees, tax, totals) from listings, delivery_options and
-- tax_rates. checkout_create() runs in one transaction: it locks the
-- inventory rows, re-prices, refuses if the total differs from what the
-- buyer saw (expected_total), reserves stock, creates the checkout and seller
-- orders, and removes the bought lines from the cart. It is idempotent per
-- (buyer, client_request_id): a retried "Place order" returns the same
-- checkout. Nothing is paid here (Stage E); orders wait in pending_payment.

-- ---------------------------------------------------------------------------
-- Jamaican parishes
-- ---------------------------------------------------------------------------
create or replace function private.is_parish(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p in ('Kingston', 'St. Andrew', 'St. Thomas', 'Portland', 'St. Mary', 'St. Ann', 'Trelawny', 'St. James',
               'Hanover', 'Westmoreland', 'St. Elizabeth', 'Manchester', 'Clarendon', 'St. Catherine');
$$;

create or replace function private.are_parishes(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(bool_and(private.is_parish(x)), true) from unnest(p) x;
$$;

-- Used by check constraints, which run as the writing user: signed-in users only.
revoke all on function private.is_parish(text) from public, anon;
revoke all on function private.are_parishes(text[]) from public, anon;
grant execute on function private.is_parish(text) to authenticated;
grant execute on function private.are_parishes(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Addresses (owner-only)
-- ---------------------------------------------------------------------------
create table public.addresses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  label          text check (char_length(label) <= 40),
  recipient_name text not null check (char_length(btrim(recipient_name)) between 1 and 120),
  phone          text not null check (phone ~ '^\+?[0-9 ()-]{7,20}$'),
  line1          text not null check (char_length(btrim(line1)) between 1 and 200),
  line2          text check (char_length(line2) <= 200),
  town           text not null check (char_length(btrim(town)) between 1 and 80),
  parish         text not null check (private.is_parish(parish)),
  instructions   text check (char_length(instructions) <= 300),
  is_default     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index addresses_user_idx on public.addresses (user_id);
create unique index addresses_one_default on public.addresses (user_id) where is_default;

create trigger addresses_set_updated_at before update on public.addresses
  for each row execute function private.set_updated_at();

create or replace function private.set_address_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.user_id := coalesce(private.current_active_user_id(), new.user_id);
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'addresses cannot change owner' using errcode = '42501';
  end if;
  -- One default address: setting a new default clears the old one.
  if new.is_default then
    update public.addresses set is_default = false where user_id = new.user_id and id <> new.id and is_default;
  end if;
  return new;
end;
$$;

revoke all on function private.set_address_owner() from public, anon, authenticated;

create trigger addresses_set_owner before insert or update on public.addresses
  for each row execute function private.set_address_owner();

-- ---------------------------------------------------------------------------
-- Seller delivery options and GCT registration
-- ---------------------------------------------------------------------------
alter table public.seller_profiles
  add column gct_registered boolean not null default false;

comment on column public.seller_profiles.gct_registered is
  'The seller says they are registered for GCT and must charge it (decision D9: owner/accountant to confirm).';

grant update (gct_registered) on public.seller_profiles to authenticated;

create table public.delivery_options (
  seller_profile_id  uuid primary key,
  community_id       uuid not null,
  fee_minor          bigint not null check (fee_minor between 0 and 100000000),
  currency           char(3) not null default 'JMD' check (currency = 'JMD'),
  -- Parishes delivered to; empty = every parish.
  parishes           text[] not null default '{}'::text[] check (private.are_parishes(parishes)),
  -- Only what the seller states; never invented. Null = no estimate.
  estimated_days_min integer check (estimated_days_min between 0 and 60),
  estimated_days_max integer check (estimated_days_max between 0 and 60),
  active             boolean not null default true,
  updated_at         timestamptz not null default now(),
  constraint delivery_options_estimate check (estimated_days_min is null or estimated_days_max is null or estimated_days_min <= estimated_days_max),
  constraint delivery_options_seller_fkey foreign key (seller_profile_id, community_id)
    references public.seller_profiles (id, community_id) on delete cascade
);

create trigger delivery_options_set_updated_at before update on public.delivery_options
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Tax rates (platform-wide, managed by migration or operators)
-- ---------------------------------------------------------------------------
create table public.tax_rates (
  id             uuid primary key default gen_random_uuid(),
  code           text not null check (code ~ '^[A-Z][A-Z_]*$'),
  rate_bps       integer not null check (rate_bps between 0 and 10000),
  effective_from timestamptz not null,
  effective_to   timestamptz,
  note           text,
  constraint tax_rates_period check (effective_to is null or effective_to > effective_from)
);

insert into public.tax_rates (code, rate_bps, effective_from, note) values
  ('GCT_STANDARD', 1500, '2016-07-01T00:00:00Z',
   'General Consumption Tax standard rate. Owner and accountant to confirm (decision D9).');

-- ---------------------------------------------------------------------------
-- Checkouts, orders, items, events, reservations
-- ---------------------------------------------------------------------------
create table public.checkouts (
  id                     uuid primary key default gen_random_uuid(),
  community_id           uuid not null references public.communities (id) on delete restrict,
  buyer_user_id          uuid references public.profiles (id) on delete set null,
  client_request_id      uuid not null,
  currency               char(3) not null default 'JMD' check (currency = 'JMD'),
  subtotal_minor         bigint not null check (subtotal_minor >= 0),
  delivery_minor         bigint not null check (delivery_minor >= 0),
  tax_minor              bigint not null check (tax_minor >= 0),
  discount_minor         bigint not null default 0 check (discount_minor >= 0),
  total_minor            bigint not null check (total_minor = subtotal_minor + delivery_minor + tax_minor - discount_minor),
  status                 text not null default 'awaiting_payment'
                         check (status in ('awaiting_payment', 'payment_failed', 'paid', 'expired', 'cancelled',
                                           'partially_refunded', 'refunded')),
  reservation_expires_at timestamptz not null,
  terms_version          text not null check (char_length(terms_version) between 1 and 40),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  paid_at                timestamptz,
  constraint checkouts_buyer_request_key unique (buyer_user_id, client_request_id),
  constraint checkouts_id_community_key unique (id, community_id)
);

create index checkouts_buyer_idx on public.checkouts (buyer_user_id, created_at desc);
create index checkouts_pending_idx on public.checkouts (reservation_expires_at) where status in ('awaiting_payment', 'payment_failed');

create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  checkout_id        uuid not null,
  community_id       uuid not null,
  buyer_user_id      uuid references public.profiles (id) on delete set null,
  seller_user_id     uuid references public.profiles (id) on delete set null,
  seller_profile_id  uuid references public.seller_profiles (id) on delete set null,
  seller_name        text not null,
  status             text not null default 'pending_payment'
                     check (status in ('pending_payment', 'paid', 'accepted', 'rejected', 'processing',
                                       'ready_for_pickup', 'out_for_delivery', 'delivery_failed', 'delivered',
                                       'completed', 'cancelled')),
  fulfillment_method text not null check (fulfillment_method in ('pickup', 'seller_delivery')),
  address_snapshot   jsonb,
  contact_snapshot   jsonb not null,
  currency           char(3) not null default 'JMD',
  subtotal_minor     bigint not null check (subtotal_minor >= 0),
  delivery_minor     bigint not null check (delivery_minor >= 0),
  tax_minor          bigint not null check (tax_minor >= 0),
  total_minor        bigint not null check (total_minor = subtotal_minor + delivery_minor + tax_minor),
  estimated_days_min integer,
  estimated_days_max integer,
  status_reason      text check (char_length(status_reason) <= 500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint orders_checkout_fkey foreign key (checkout_id, community_id)
    references public.checkouts (id, community_id) on delete restrict,
  constraint orders_delivery_address check (fulfillment_method = 'pickup' or address_snapshot is not null)
);

create index orders_checkout_idx on public.orders (checkout_id);
create index orders_buyer_idx on public.orders (buyer_user_id, created_at desc);
create index orders_seller_idx on public.orders (seller_user_id, status, created_at desc);

create table public.order_items (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.orders (id) on delete restrict,
  listing_id          uuid references public.listings (id) on delete set null,
  title_snapshot      text not null,
  image_path_snapshot text,
  unit_price_minor    bigint not null check (unit_price_minor >= 0),
  quantity            integer not null check (quantity between 1 and 99),
  tax_minor           bigint not null check (tax_minor >= 0),
  line_total_minor    bigint not null check (line_total_minor = unit_price_minor * quantity)
);

create index order_items_order_idx on public.order_items (order_id);

create table public.order_events (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete restrict,
  from_status   text,
  to_status     text not null,
  actor_user_id uuid references public.profiles (id) on delete set null,
  reason        text check (char_length(reason) <= 500),
  created_at    timestamptz not null default now()
);

create index order_events_order_idx on public.order_events (order_id, created_at);

create table public.inventory_reservations (
  id          uuid primary key default gen_random_uuid(),
  checkout_id uuid not null references public.checkouts (id) on delete restrict,
  listing_id  uuid not null references public.inventory (listing_id) on delete restrict,
  quantity    integer not null check (quantity between 1 and 99),
  status      text not null default 'held' check (status in ('held', 'committed', 'released')),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  constraint inventory_reservations_unique unique (checkout_id, listing_id)
);

create index inventory_reservations_held_idx on public.inventory_reservations (expires_at) where status = 'held';

create trigger checkouts_set_updated_at before update on public.checkouts
  for each row execute function private.set_updated_at();
create trigger orders_set_updated_at before update on public.orders
  for each row execute function private.set_updated_at();

-- Purchase-time records are never rewritten.
create trigger order_items_append_only before update or delete on public.order_items
  for each row execute function private.forbid_change();
create trigger order_events_append_only before update or delete on public.order_events
  for each row execute function private.forbid_change();

-- Totals and parties of a checkout or order never change after creation.
create or replace function private.freeze_order_money()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'checkouts' then
    if (new.community_id, new.buyer_user_id, new.client_request_id, new.subtotal_minor, new.delivery_minor, new.tax_minor,
        new.discount_minor, new.total_minor, new.currency, new.terms_version, new.created_at)
       is distinct from
       (old.community_id, old.buyer_user_id, old.client_request_id, old.subtotal_minor, old.delivery_minor, old.tax_minor,
        old.discount_minor, old.total_minor, old.currency, old.terms_version, old.created_at)
       and not (old.buyer_user_id is not null and new.buyer_user_id is null) then
      raise exception 'checkout totals and parties are immutable' using errcode = '42501';
    end if;
  else
    if (new.checkout_id, new.community_id, new.subtotal_minor, new.delivery_minor, new.tax_minor, new.total_minor,
        new.currency, new.fulfillment_method, new.address_snapshot, new.contact_snapshot, new.created_at)
       is distinct from
       (old.checkout_id, old.community_id, old.subtotal_minor, old.delivery_minor, old.tax_minor, old.total_minor,
        old.currency, old.fulfillment_method, old.address_snapshot, old.contact_snapshot, old.created_at) then
      raise exception 'order totals and details are immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.freeze_order_money() from public, anon, authenticated;

create trigger checkouts_freeze before update on public.checkouts
  for each row execute function private.freeze_order_money();
create trigger orders_freeze before update on public.orders
  for each row execute function private.freeze_order_money();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function private.can_view_order(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order_id
      and (o.buyer_user_id = (select private.current_active_user_id())
           -- A seller sees an order (and the buyer's contact details) only once it is paid.
           or (o.seller_user_id = (select private.current_active_user_id())
               and exists (select 1 from public.checkouts c where c.id = o.checkout_id and c.paid_at is not null)))
  );
$$;

revoke all on function private.can_view_order(uuid) from public, anon, authenticated;
grant execute on function private.can_view_order(uuid) to authenticated;

-- Records a status change (called by every transition function).
create or replace function private.order_transition(p_order_id uuid, p_to text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
begin
  select status into v_from from public.orders where id = p_order_id for update;
  if v_from is distinct from p_to then
    update public.orders set status = p_to, status_reason = coalesce(p_reason, status_reason) where id = p_order_id;
    insert into public.order_events (order_id, from_status, to_status, actor_user_id, reason)
    values (p_order_id, v_from, p_to, private.actor_user_id(), p_reason);
  end if;
end;
$$;

revoke all on function private.order_transition(uuid, text, text) from public, anon, authenticated, service_role;

-- Releases a checkout's held stock (cancel, expiry, failure after expiry).
create or replace function private.release_reservations(p_checkout_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select ir.id, ir.listing_id, ir.quantity from public.inventory_reservations ir
    where ir.checkout_id = p_checkout_id and ir.status = 'held'
    order by ir.listing_id
  loop
    update public.inventory set reserved = reserved - r.quantity, updated_at = now() where listing_id = r.listing_id;
    update public.inventory_reservations set status = 'released' where id = r.id;
  end loop;
end;
$$;

revoke all on function private.release_reservations(uuid) from public, anon, authenticated, service_role;

-- Prices the buyer's cart in one community, with fulfillment choices per
-- seller: [{ "seller_profile_id": "...", "method": "pickup" | "seller_delivery" }].
-- Returns a document with per-seller lines and totals, and `problems` (a
-- checkout is only possible when problems is empty). Reads current prices,
-- stock, delivery options and tax rates; nothing from the client but the
-- choices and the address id (which must be the buyer's own).
create or replace function private.price_checkout(p_buyer uuid, p_community_id uuid, p_choices jsonb, p_address_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_address  public.addresses;
  v_rate     integer;
  v_seller   record;
  v_method   text;
  v_option   public.delivery_options;
  v_lines    jsonb;
  v_sub      bigint;
  v_tax      bigint;
  v_fee      bigint;
  v_sellers  jsonb := '[]'::jsonb;
  v_problems jsonb := '[]'::jsonb;
  v_t_sub    bigint := 0;
  v_t_tax    bigint := 0;
  v_t_fee    bigint := 0;
begin
  if p_address_id is not null then
    select * into v_address from public.addresses a where a.id = p_address_id and a.user_id = p_buyer;
    if v_address.id is null then
      raise exception 'address not found' using errcode = 'P0002';
    end if;
  end if;
  if p_choices is not null and jsonb_typeof(p_choices) <> 'array' then
    raise exception 'choices must be a list' using errcode = '22023';
  end if;
  select t.rate_bps into v_rate from public.tax_rates t
  where t.code = 'GCT_STANDARD' and t.effective_from <= now() and (t.effective_to is null or t.effective_to > now())
  order by t.effective_from desc limit 1;

  for v_seller in
    select s.id as seller_profile_id, s.user_id, s.display_name, s.gct_registered, s.status
    from public.carts c
    join public.cart_items ci on ci.cart_id = c.id
    join public.listings l on l.id = ci.listing_id
    join public.seller_profiles s on s.id = l.seller_profile_id
    where c.user_id = p_buyer and c.community_id = p_community_id
    group by s.id, s.user_id, s.display_name, s.gct_registered, s.status
    order by s.display_name, s.id
  loop
    select e->>'method' into v_method
    from jsonb_array_elements(coalesce(p_choices, '[]'::jsonb)) e
    where e->>'seller_profile_id' = v_seller.seller_profile_id::text
    limit 1;

    select jsonb_agg(jsonb_build_object(
             'listing_id', l.id, 'title', l.title, 'quantity', ci.quantity, 'unit_price_minor', l.price_minor,
             'line_total_minor', l.price_minor * ci.quantity,
             'tax_minor', case when v_seller.gct_registered then (l.price_minor * ci.quantity * coalesce(v_rate, 0) + 5000) / 10000 else 0 end,
             'image_path', (select li.storage_path from public.listing_images li where li.listing_id = l.id order by li.position limit 1),
             'fulfillment', to_jsonb(l.fulfillment),
             'issue', case
               when l.status <> 'active' or v_seller.status <> 'active' or l.kind <> 'product' or l.price_minor is null then 'unavailable'
               when coalesce(i.on_hand - i.reserved, 0) < ci.quantity then 'insufficient_stock'
             end) order by ci.added_at),
           sum(l.price_minor * ci.quantity),
           sum(case when v_seller.gct_registered then (l.price_minor * ci.quantity * coalesce(v_rate, 0) + 5000) / 10000 else 0 end)
      into v_lines, v_sub, v_tax
    from public.carts c
    join public.cart_items ci on ci.cart_id = c.id
    join public.listings l on l.id = ci.listing_id
    left join public.inventory i on i.listing_id = l.id
    where c.user_id = p_buyer and c.community_id = p_community_id and l.seller_profile_id = v_seller.seller_profile_id;

    v_problems := v_problems || coalesce((
      select jsonb_agg(jsonb_build_object('listing_id', x->>'listing_id', 'problem', x->>'issue'))
      from jsonb_array_elements(v_lines) x where x->>'issue' is not null), '[]'::jsonb);

    v_fee := 0;
    select * into v_option from public.delivery_options d where d.seller_profile_id = v_seller.seller_profile_id and d.active;
    if v_method is null then
      v_problems := v_problems || jsonb_build_object('seller_profile_id', v_seller.seller_profile_id, 'problem', 'choose_fulfillment');
    elsif v_method not in ('pickup', 'seller_delivery')
       or exists (select 1 from jsonb_array_elements(v_lines) x where not (x->'fulfillment') ? v_method) then
      v_problems := v_problems || jsonb_build_object('seller_profile_id', v_seller.seller_profile_id, 'problem', 'method_not_offered');
    elsif v_method = 'seller_delivery' then
      if v_address.id is null then
        v_problems := v_problems || jsonb_build_object('seller_profile_id', v_seller.seller_profile_id, 'problem', 'address_required');
      elsif v_option.seller_profile_id is null
         or (cardinality(v_option.parishes) > 0 and not v_address.parish = any (v_option.parishes)) then
        v_problems := v_problems || jsonb_build_object('seller_profile_id', v_seller.seller_profile_id, 'problem', 'delivery_not_available');
      else
        v_fee := v_option.fee_minor;
      end if;
    end if;

    v_sellers := v_sellers || jsonb_build_object(
      'seller_profile_id', v_seller.seller_profile_id, 'seller_user_id', v_seller.user_id, 'seller_name', v_seller.display_name,
      'method', v_method, 'delivery_minor', v_fee, 'subtotal_minor', v_sub, 'tax_minor', v_tax,
      'total_minor', v_sub + v_fee + v_tax, 'lines', v_lines,
      'delivery_available', v_option.seller_profile_id is not null
        and (v_address.id is null or cardinality(v_option.parishes) = 0 or v_address.parish = any (v_option.parishes)),
      'delivery_fee_minor', v_option.fee_minor,
      'estimated_days_min', v_option.estimated_days_min, 'estimated_days_max', v_option.estimated_days_max);
    v_t_sub := v_t_sub + v_sub;
    v_t_tax := v_t_tax + v_tax;
    v_t_fee := v_t_fee + v_fee;
  end loop;

  if jsonb_array_length(v_sellers) = 0 then
    v_problems := v_problems || jsonb_build_object('problem', 'cart_empty');
  end if;
  return jsonb_build_object(
    'currency', 'JMD', 'sellers', v_sellers, 'subtotal_minor', v_t_sub, 'delivery_minor', v_t_fee,
    'tax_minor', v_t_tax, 'discount_minor', 0, 'total_minor', v_t_sub + v_t_fee + v_t_tax, 'problems', v_problems,
    'tax_rate_bps', coalesce(v_rate, 0));
end;
$$;

revoke all on function private.price_checkout(uuid, uuid, jsonb, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Checkout API
-- ---------------------------------------------------------------------------
create or replace function public.checkout_preview(p_community_id uuid, p_choices jsonb default '[]'::jsonb, p_address_id uuid default null)
returns jsonb
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
  return private.price_checkout(v_me, p_community_id, p_choices, p_address_id);
end;
$$;

create or replace function public.checkout_create(
  p_community_id         uuid,
  p_client_request_id    uuid,
  p_choices              jsonb,
  p_address_id           uuid,
  p_contact_name         text,
  p_contact_phone        text,
  p_expected_total_minor bigint,
  p_terms_version        text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me       uuid := private.current_active_user_id();
  v_existing uuid;
  v_price    jsonb;
  v_checkout uuid;
  v_order    uuid;
  v_seller   jsonb;
  v_line     jsonb;
  v_address  jsonb;
  v_expires  timestamptz := now() + interval '20 minutes';
begin
  if v_me is null or not public.has_community_permission(p_community_id, 'marketplace.buy') then
    raise exception 'marketplace.buy is required in this community' using errcode = '42501';
  end if;
  if p_client_request_id is null then
    raise exception 'client_request_id is required' using errcode = '22023';
  end if;

  -- Idempotent: a retried "Place order" returns the first checkout.
  select id into v_existing from public.checkouts where buyer_user_id = v_me and client_request_id = p_client_request_id;
  if v_existing is not null then
    return v_existing;
  end if;

  if p_contact_name is null or char_length(btrim(p_contact_name)) not between 1 and 120 then
    raise exception 'enter the name for this order' using errcode = '22023';
  end if;
  if p_contact_phone is null or p_contact_phone !~ '^\+?[0-9 ()-]{7,20}$' then
    raise exception 'enter a phone number for this order' using errcode = '22023';
  end if;
  if p_terms_version is null or char_length(p_terms_version) not between 1 and 40 then
    raise exception 'accept the order terms' using errcode = '22023';
  end if;

  perform private.enforce_rate_limit('checkout.create');

  -- Lock the stock of everything in the cart (in a fixed order: no deadlocks).
  perform 1 from public.inventory i
  where i.listing_id in (
    select ci.listing_id from public.carts c join public.cart_items ci on ci.cart_id = c.id
    where c.user_id = v_me and c.community_id = p_community_id)
  order by i.listing_id
  for update;

  v_price := private.price_checkout(v_me, p_community_id, p_choices, p_address_id);
  if jsonb_array_length(v_price->'problems') > 0 then
    raise exception 'checkout is not possible: %', (v_price->'problems'->0->>'problem') using errcode = '22023';
  end if;
  if p_expected_total_minor is distinct from (v_price->>'total_minor')::bigint then
    raise exception 'the total changed to %; review your order', (v_price->>'total_minor')::bigint using errcode = '22023';
  end if;

  if p_address_id is not null then
    select jsonb_build_object('recipient_name', a.recipient_name, 'phone', a.phone, 'line1', a.line1, 'line2', a.line2,
                              'town', a.town, 'parish', a.parish, 'instructions', a.instructions)
      into v_address from public.addresses a where a.id = p_address_id and a.user_id = v_me;
  end if;

  insert into public.checkouts (community_id, buyer_user_id, client_request_id, subtotal_minor, delivery_minor, tax_minor,
                                total_minor, reservation_expires_at, terms_version)
  values (p_community_id, v_me, p_client_request_id, (v_price->>'subtotal_minor')::bigint, (v_price->>'delivery_minor')::bigint,
          (v_price->>'tax_minor')::bigint, (v_price->>'total_minor')::bigint, v_expires, p_terms_version)
  returning id into v_checkout;

  for v_seller in select * from jsonb_array_elements(v_price->'sellers') loop
    insert into public.orders (checkout_id, community_id, buyer_user_id, seller_user_id, seller_profile_id, seller_name,
                               fulfillment_method, address_snapshot, contact_snapshot, subtotal_minor, delivery_minor,
                               tax_minor, total_minor, estimated_days_min, estimated_days_max)
    values (v_checkout, p_community_id, v_me, (v_seller->>'seller_user_id')::uuid, (v_seller->>'seller_profile_id')::uuid,
            v_seller->>'seller_name', v_seller->>'method',
            case when v_seller->>'method' = 'seller_delivery' then v_address end,
            jsonb_build_object('name', btrim(p_contact_name), 'phone', btrim(p_contact_phone)),
            (v_seller->>'subtotal_minor')::bigint, (v_seller->>'delivery_minor')::bigint, (v_seller->>'tax_minor')::bigint,
            (v_seller->>'total_minor')::bigint,
            case when v_seller->>'method' = 'seller_delivery' then (v_seller->>'estimated_days_min')::integer end,
            case when v_seller->>'method' = 'seller_delivery' then (v_seller->>'estimated_days_max')::integer end)
    returning id into v_order;
    insert into public.order_events (order_id, from_status, to_status, actor_user_id) values (v_order, null, 'pending_payment', v_me);

    for v_line in select * from jsonb_array_elements(v_seller->'lines') loop
      insert into public.order_items (order_id, listing_id, title_snapshot, image_path_snapshot, unit_price_minor, quantity,
                                      tax_minor, line_total_minor)
      values (v_order, (v_line->>'listing_id')::uuid, v_line->>'title', v_line->>'image_path',
              (v_line->>'unit_price_minor')::bigint, (v_line->>'quantity')::integer, (v_line->>'tax_minor')::bigint,
              (v_line->>'line_total_minor')::bigint);
      insert into public.inventory_reservations (checkout_id, listing_id, quantity, expires_at)
      values (v_checkout, (v_line->>'listing_id')::uuid, (v_line->>'quantity')::integer, v_expires);
      update public.inventory set reserved = reserved + (v_line->>'quantity')::integer, updated_at = now()
      where listing_id = (v_line->>'listing_id')::uuid;
    end loop;
  end loop;

  -- The bought lines leave the cart.
  delete from public.cart_items ci using public.carts c
  where c.id = ci.cart_id and c.user_id = v_me and c.community_id = p_community_id;

  perform private.record_audit_event(p_community_id, 'checkout.created', 'checkout', v_checkout,
    jsonb_build_object('total_minor', (v_price->>'total_minor')::bigint, 'orders', jsonb_array_length(v_price->'sellers')));
  return v_checkout;
end;
$$;

-- The buyer cancels a checkout that is not paid: stock goes back.
create or replace function public.checkout_cancel(p_checkout_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_checkout public.checkouts;
  v_order    record;
begin
  select * into v_checkout from public.checkouts where id = p_checkout_id for update;
  if v_checkout.id is null or v_checkout.buyer_user_id is distinct from private.current_active_user_id() then
    raise exception 'checkout not found' using errcode = 'P0002';
  end if;
  if v_checkout.status not in ('awaiting_payment', 'payment_failed') then
    raise exception 'this checkout can no longer be cancelled (%)', v_checkout.status using errcode = '22023';
  end if;
  update public.checkouts set status = 'cancelled' where id = p_checkout_id;
  for v_order in select id from public.orders where checkout_id = p_checkout_id loop
    perform private.order_transition(v_order.id, 'cancelled', 'Cancelled before payment');
  end loop;
  perform private.release_reservations(p_checkout_id);
end;
$$;

-- Housekeeping (service role, e.g. every minute): unpaid checkouts whose
-- reservation ended are expired and their stock released. A payment that
-- succeeds later is handled by apply_payment_event (re-reserve or refund).
create or replace function public.expire_checkouts()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_checkout record;
  v_order    record;
  v_count    integer := 0;
begin
  for v_checkout in
    select id from public.checkouts
    where status in ('awaiting_payment', 'payment_failed') and reservation_expires_at <= now()
    order by reservation_expires_at
    for update skip locked
  loop
    update public.checkouts set status = 'expired' where id = v_checkout.id;
    for v_order in select id from public.orders where checkout_id = v_checkout.id loop
      perform private.order_transition(v_order.id, 'cancelled', 'Not paid in time');
    end loop;
    perform private.release_reservations(v_checkout.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.checkout_preview(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.checkout_create(uuid, uuid, jsonb, uuid, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.checkout_cancel(uuid) from public, anon, authenticated;
revoke all on function public.expire_checkouts() from public, anon, authenticated;
grant execute on function public.checkout_preview(uuid, jsonb, uuid) to authenticated;
grant execute on function public.checkout_create(uuid, uuid, jsonb, uuid, text, text, bigint, text) to authenticated;
grant execute on function public.checkout_cancel(uuid) to authenticated;
grant execute on function public.expire_checkouts() to service_role;

insert into private.rate_limit_rules (action, max_count, window_seconds, description) values
  ('checkout.create', 30, 3600, 'Checkouts started per user per hour')
on conflict (action) do nothing;

insert into public.audit_actions (action, entity_type, description) values
  ('checkout.created', 'checkout', 'A buyer placed a marketplace order (awaiting payment)')
on conflict (action) do nothing;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on table public.addresses, public.delivery_options, public.tax_rates, public.checkouts, public.orders,
  public.order_items, public.order_events, public.inventory_reservations from public, anon, authenticated;
grant all on table public.addresses, public.delivery_options, public.tax_rates, public.checkouts, public.orders,
  public.order_items, public.order_events, public.inventory_reservations to service_role;
alter table public.addresses              enable row level security;
alter table public.delivery_options       enable row level security;
alter table public.tax_rates              enable row level security;
alter table public.checkouts              enable row level security;
alter table public.orders                 enable row level security;
alter table public.order_items            enable row level security;
alter table public.order_events           enable row level security;
alter table public.inventory_reservations enable row level security;

-- Addresses: yours only.
grant select, delete on public.addresses to authenticated;
grant insert (label, recipient_name, phone, line1, line2, town, parish, instructions, is_default) on public.addresses to authenticated;
grant update (label, recipient_name, phone, line1, line2, town, parish, instructions, is_default) on public.addresses to authenticated;
create policy addresses_own on public.addresses
  for all to authenticated
  using (user_id = (select private.current_active_user_id()))
  with check (user_id = (select private.current_active_user_id()));

-- Delivery options: the shop's owner writes; members see active options of active shops.
grant select on public.delivery_options to authenticated;
grant insert (seller_profile_id, community_id, fee_minor, parishes, estimated_days_min, estimated_days_max, active) on public.delivery_options to authenticated;
grant update (fee_minor, parishes, estimated_days_min, estimated_days_max, active) on public.delivery_options to authenticated;
create policy delivery_options_select on public.delivery_options
  for select to authenticated
  using (exists (select 1 from public.seller_profiles s where s.id = seller_profile_id
                 and (s.user_id = (select private.current_active_user_id())
                      or (s.status = 'active' and active and public.has_community_permission(s.community_id, 'marketplace.view')))));
create policy delivery_options_write on public.delivery_options
  for insert to authenticated
  -- (seller_profile_id, community_id) must match: enforced by the composite foreign key.
  with check (exists (select 1 from public.seller_profiles s where s.id = seller_profile_id
                      and s.user_id = (select private.current_active_user_id())
                      and public.has_community_permission(s.community_id, 'marketplace.sell')));
create policy delivery_options_update on public.delivery_options
  for update to authenticated
  using (exists (select 1 from public.seller_profiles s where s.id = seller_profile_id
                 and s.user_id = (select private.current_active_user_id())
                 and public.has_community_permission(s.community_id, 'marketplace.sell')));

-- Tax rates: readable.
grant select on public.tax_rates to authenticated;
create policy tax_rates_select on public.tax_rates for select to authenticated using (true);

-- Checkouts: the buyer's own. Orders: the buyer's, and the seller's once paid.
grant select on public.checkouts, public.orders, public.order_items, public.order_events to authenticated;
create policy checkouts_select_buyer on public.checkouts
  for select to authenticated using (buyer_user_id = (select private.current_active_user_id()));
create policy orders_select_parties on public.orders
  for select to authenticated
  using (buyer_user_id = (select private.current_active_user_id()) or private.can_view_order(id));
create policy order_items_select_parties on public.order_items
  for select to authenticated using (private.can_view_order(order_id));
create policy order_events_select_parties on public.order_events
  for select to authenticated using (private.can_view_order(order_id));
