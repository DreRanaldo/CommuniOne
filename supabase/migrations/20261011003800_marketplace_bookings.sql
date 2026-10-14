-- Marketplace Stage J / Migration 38: service bookings.
--
--   requested ──seller accepts (price fixed now)──> accepted ──paid──> confirmed ──seller──> completed
--   requested ──seller proposes another time──> proposed ──buyer accepts──> accepted
--   requested|proposed ──seller declines──> declined
--   requested|proposed|accepted ──buyer or seller──> cancelled
--   confirmed ──buyer or seller cancels──> cancelled + full refund record
--   accepted, unpaid past payment_due_at ──job──> expired
--   confirmed, 3 days after the end ──job──> completed
--
-- A seller can never hold two accepted/confirmed bookings at overlapping
-- times: an exclusion constraint enforces it, so concurrent acceptances
-- cannot double-book. Times are timestamptz; availability windows are in
-- the seller's local time (America/Jamaica, no daylight saving).
--
-- The amount is fixed by the server when the seller accepts: the listing's
-- fixed price, hourly price x duration, or (quote-priced) the seller's price.
-- Payment uses the same payment API as checkouts (payment_begin_booking).
-- Cancellation fees are NOT implemented (decision D6): a paid booking that is
-- cancelled is refunded in full.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------
create table public.service_availability (
  id                uuid primary key default gen_random_uuid(),
  seller_profile_id uuid not null references public.seller_profiles (id) on delete cascade,
  community_id      uuid not null,
  weekday           smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  start_time        time not null,
  end_time          time not null,
  constraint service_availability_order check (end_time > start_time),
  constraint service_availability_seller_fkey foreign key (seller_profile_id, community_id)
    references public.seller_profiles (id, community_id) on delete cascade
);

create index service_availability_seller_idx on public.service_availability (seller_profile_id, weekday);

create table public.service_time_off (
  id                uuid primary key default gen_random_uuid(),
  seller_profile_id uuid not null references public.seller_profiles (id) on delete cascade,
  period            tstzrange not null check (not isempty(period) and lower(period) is not null and upper(period) is not null),
  note              text check (char_length(note) <= 200),
  created_at        timestamptz not null default now()
);

create index service_time_off_period_idx on public.service_time_off using gist (seller_profile_id, period);

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
create table public.bookings (
  id                uuid primary key default gen_random_uuid(),
  community_id      uuid not null references public.communities (id) on delete restrict,
  listing_id        uuid references public.listings (id) on delete set null,
  seller_profile_id uuid not null references public.seller_profiles (id) on delete restrict,
  seller_user_id    uuid references public.profiles (id) on delete set null,
  buyer_user_id     uuid references public.profiles (id) on delete set null,
  title_snapshot    text not null,
  pricing_snapshot  text not null check (pricing_snapshot in ('fixed', 'hourly', 'quote')),
  unit_price_minor  bigint check (unit_price_minor >= 0),
  period            tstzrange not null check (not isempty(period) and lower(period) is not null and upper(period) is not null),
  status            text not null default 'requested'
                    check (status in ('requested', 'proposed', 'accepted', 'confirmed', 'declined', 'cancelled', 'expired', 'completed')),
  amount_minor      bigint check (amount_minor > 0),
  currency          char(3) not null default 'JMD',
  buyer_note        text check (char_length(buyer_note) <= 1000),
  location_note     text check (char_length(location_note) <= 300),
  status_reason     text check (char_length(status_reason) <= 500),
  payment_due_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint bookings_amount_when_accepted check (status in ('requested', 'proposed', 'declined', 'cancelled', 'expired') or amount_minor is not null),
  -- A seller is never booked twice at the same time.
  constraint bookings_no_double_booking exclude using gist (seller_profile_id with =, period with &&)
    where (status in ('accepted', 'confirmed'))
);

create index bookings_buyer_idx on public.bookings (buyer_user_id, created_at desc);
create index bookings_seller_idx on public.bookings (seller_user_id, status, lower(period));

create trigger bookings_set_updated_at before update on public.bookings
  for each row execute function private.set_updated_at();

create table public.booking_events (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null references public.bookings (id) on delete restrict,
  from_status   text,
  to_status     text not null,
  actor_user_id uuid references public.profiles (id) on delete set null,
  reason        text,
  created_at    timestamptz not null default now()
);

create index booking_events_booking_idx on public.booking_events (booking_id, created_at);
create trigger booking_events_append_only before update or delete on public.booking_events
  for each row execute function private.forbid_change();

-- Payments and disputes can now point at bookings.
alter table public.payments add constraint payments_booking_fkey foreign key (booking_id) references public.bookings (id) on delete restrict;
create unique index payments_one_success_per_booking on public.payments (booking_id)
  where status = 'succeeded' and failure_code is null and booking_id is not null;
alter table public.refunds add constraint refunds_booking_fkey foreign key (booking_id) references public.bookings (id) on delete restrict;

alter table public.disputes alter column order_id drop not null;
alter table public.disputes add column booking_id uuid references public.bookings (id) on delete restrict;
alter table public.disputes add constraint disputes_one_subject check (num_nonnulls(order_id, booking_id) = 1);
create unique index disputes_one_open_per_booking on public.disputes (booking_id) where status = 'open' and booking_id is not null;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function private.booking_transition(p_booking_id uuid, p_to text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
begin
  select status into v_from from public.bookings where id = p_booking_id for update;
  if v_from is distinct from p_to then
    update public.bookings set status = p_to, status_reason = coalesce(p_reason, status_reason) where id = p_booking_id;
    insert into public.booking_events (booking_id, from_status, to_status, actor_user_id, reason)
    values (p_booking_id, v_from, p_to, private.actor_user_id(), p_reason);
  end if;
end;
$$;

revoke all on function private.booking_transition(uuid, text, text) from public, anon, authenticated, service_role;

create or replace function private.booking_notify(p_booking public.bookings, p_to_buyer boolean, p_title text, p_body text, p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := case when p_to_buyer then p_booking.buyer_user_id else p_booking.seller_user_id end;
begin
  if v_user is not null then
    perform private.create_notification(v_user, p_booking.community_id, 'booking', p_title, p_body,
      jsonb_build_object('booking_id', p_booking.id), 'booking:' || p_booking.id || ':' || p_key);
  end if;
end;
$$;

revoke all on function private.booking_notify(public.bookings, boolean, text, text, text) from public, anon, authenticated, service_role;

-- Inside the seller's weekly hours (when they set any), not on time off.
create or replace function private.booking_time_ok(p_seller_profile_id uuid, p_period tstzrange)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
    not exists (select 1 from public.service_availability a where a.seller_profile_id = p_seller_profile_id)
    or exists (
      select 1 from public.service_availability a
      where a.seller_profile_id = p_seller_profile_id
        and a.weekday = extract(dow from lower(p_period) at time zone 'America/Jamaica')
        and (lower(p_period) at time zone 'America/Jamaica')::date = (upper(p_period) at time zone 'America/Jamaica')::date
        and (lower(p_period) at time zone 'America/Jamaica')::time >= a.start_time
        and (upper(p_period) at time zone 'America/Jamaica')::time <= a.end_time
    ))
    and not exists (select 1 from public.service_time_off t where t.seller_profile_id = p_seller_profile_id and t.period && p_period);
$$;

revoke all on function private.booking_time_ok(uuid, tstzrange) from public, anon, authenticated, service_role;

create or replace function private.check_booking_period(p_starts_at timestamptz, p_ends_at timestamptz)
returns tstzrange
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'choose a start and an end time' using errcode = '22023';
  end if;
  if p_starts_at < now() + interval '1 hour' then
    raise exception 'bookings start at least an hour from now' using errcode = '22023';
  end if;
  if p_starts_at > now() + interval '180 days' then
    raise exception 'bookings can be made up to 180 days ahead' using errcode = '22023';
  end if;
  if p_ends_at - p_starts_at < interval '15 minutes' or p_ends_at - p_starts_at > interval '12 hours' then
    raise exception 'a booking lasts from 15 minutes to 12 hours' using errcode = '22023';
  end if;
  return tstzrange(p_starts_at, p_ends_at, '[)');
end;
$$;

revoke all on function private.check_booking_period(timestamptz, timestamptz) from public, anon, authenticated, service_role;

-- The server's price for a booking.
create or replace function private.booking_amount(p_booking public.bookings, p_quote_minor bigint)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_booking.pricing_snapshot = 'fixed' then
    return p_booking.unit_price_minor;
  elsif p_booking.pricing_snapshot = 'hourly' then
    -- Rounded to the nearest cent.
    return round(p_booking.unit_price_minor * extract(epoch from upper(p_booking.period) - lower(p_booking.period)) / 3600.0)::bigint;
  end if;
  if p_quote_minor is null or p_quote_minor <= 0 or p_quote_minor > 100000000 then
    raise exception 'set the price for this booking' using errcode = '22023';
  end if;
  return p_quote_minor;
end;
$$;

revoke all on function private.booking_amount(public.bookings, bigint) from public, anon, authenticated, service_role;

create or replace function private.my_booking(p_booking_id uuid, p_as text)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_active_user_id();
  v    public.bookings;
begin
  select * into v from public.bookings where id = p_booking_id for update;
  if v_me is null or v.id is null
     or (p_as = 'seller' and v.seller_user_id is distinct from v_me)
     or (p_as = 'buyer' and v.buyer_user_id is distinct from v_me)
     or (p_as = 'either' and v_me not in (v.seller_user_id, v.buyer_user_id)) then
    raise exception 'booking not found' using errcode = 'P0002';
  end if;
  return v;
end;
$$;

revoke all on function private.my_booking(uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Seller: weekly hours and time off
-- ---------------------------------------------------------------------------
-- Replaces all weekly windows: [{ "weekday": 1, "start": "09:00", "end": "17:00" }, ...]
create or replace function public.service_availability_save(p_seller_profile_id uuid, p_windows jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_seller public.seller_profiles;
  w        jsonb;
begin
  select * into v_seller from public.seller_profiles where id = p_seller_profile_id;
  if v_seller.id is null or v_seller.user_id is distinct from private.current_active_user_id() then
    raise exception 'shop not found' using errcode = 'P0002';
  end if;
  if not public.has_community_permission(v_seller.community_id, 'marketplace.sell') then
    raise exception 'marketplace.sell is required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) > 50 then
    raise exception 'up to 50 weekly time windows' using errcode = '22023';
  end if;
  delete from public.service_availability where seller_profile_id = p_seller_profile_id;
  for w in select * from jsonb_array_elements(p_windows) loop
    begin
      insert into public.service_availability (seller_profile_id, community_id, weekday, start_time, end_time)
      values (p_seller_profile_id, v_seller.community_id, (w->>'weekday')::smallint, (w->>'start')::time, (w->>'end')::time);
    exception when check_violation or invalid_datetime_format or invalid_text_representation or datetime_field_overflow then
      raise exception 'each window needs a weekday (0-6) and a start before its end' using errcode = '22023';
    end;
  end loop;
end;
$$;

create or replace function public.service_time_off_add(p_seller_profile_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_note text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.seller_profiles s where s.id = p_seller_profile_id and s.user_id = private.current_active_user_id()) then
    raise exception 'shop not found' using errcode = 'P0002';
  end if;
  if p_ends_at is null or p_starts_at is null or p_ends_at <= p_starts_at then
    raise exception 'choose a start and an end' using errcode = '22023';
  end if;
  insert into public.service_time_off (seller_profile_id, period, note)
  values (p_seller_profile_id, tstzrange(p_starts_at, p_ends_at, '[)'), nullif(btrim(p_note), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Buyer: request
-- ---------------------------------------------------------------------------
create or replace function public.booking_request(p_listing_id uuid, p_starts_at timestamptz, p_ends_at timestamptz,
                                                  p_note text default null, p_location_note text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me      uuid := private.current_active_user_id();
  v_listing public.listings;
  v_period  tstzrange;
  v_id      uuid;
  v_booking public.bookings;
begin
  select * into v_listing from public.listings l where l.id = p_listing_id;
  if v_me is null or v_listing.id is null
     or not private.can_view_listing_row(v_listing.community_id, v_listing.seller_user_id, v_listing.status, v_listing.seller_profile_id) then
    raise exception 'listing not found' using errcode = 'P0002';
  end if;
  if not public.has_community_permission(v_listing.community_id, 'marketplace.buy') then
    raise exception 'marketplace.buy is required in this community' using errcode = '42501';
  end if;
  if v_listing.kind <> 'service' then
    raise exception 'only services are booked' using errcode = '22023';
  end if;
  if v_listing.seller_user_id = v_me then
    raise exception 'you cannot book your own service' using errcode = '22023';
  end if;
  if v_listing.status <> 'active'
     or not exists (select 1 from public.seller_profiles s where s.id = v_listing.seller_profile_id and s.status = 'active') then
    raise exception 'this service is not taking bookings right now' using errcode = '22023';
  end if;
  if (p_note is not null and char_length(p_note) > 1000) or (p_location_note is not null and char_length(p_location_note) > 300) then
    raise exception 'the note is too long' using errcode = '22023';
  end if;
  v_period := private.check_booking_period(p_starts_at, p_ends_at);
  if not private.booking_time_ok(v_listing.seller_profile_id, v_period) then
    raise exception 'the seller is not available at that time' using errcode = '22023';
  end if;
  if exists (select 1 from public.bookings b where b.seller_profile_id = v_listing.seller_profile_id
             and b.status in ('accepted', 'confirmed') and b.period && v_period) then
    raise exception 'that time is already booked' using errcode = '22023';
  end if;
  perform private.enforce_rate_limit('booking.request');

  insert into public.bookings (community_id, listing_id, seller_profile_id, seller_user_id, buyer_user_id, title_snapshot,
                               pricing_snapshot, unit_price_minor, period, currency, buyer_note, location_note)
  values (v_listing.community_id, v_listing.id, v_listing.seller_profile_id, v_listing.seller_user_id, v_me, v_listing.title,
          v_listing.pricing, v_listing.price_minor, v_period, v_listing.currency, nullif(btrim(p_note), ''), nullif(btrim(p_location_note), ''))
  returning * into v_booking;
  v_id := v_booking.id;
  insert into public.booking_events (booking_id, from_status, to_status, actor_user_id) values (v_id, null, 'requested', v_me);
  perform private.booking_notify(v_booking, false, 'New booking request', 'Someone asked to book ' || v_listing.title || '.', 'requested');
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Seller: accept, propose, decline, complete
-- ---------------------------------------------------------------------------
create or replace function public.booking_accept(p_booking_id uuid, p_price_minor bigint default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.bookings := private.my_booking(p_booking_id, 'seller');
begin
  if v.status <> 'requested' then
    raise exception 'this booking is % and cannot be accepted', v.status using errcode = '22023';
  end if;
  if lower(v.period) < now() then
    raise exception 'this booking time has passed' using errcode = '22023';
  end if;
  update public.bookings
  set amount_minor = private.booking_amount(v, p_price_minor),
      payment_due_at = least(now() + interval '24 hours', lower(v.period))
  where id = p_booking_id;
  begin
    perform private.booking_transition(p_booking_id, 'accepted', null);
  exception when exclusion_violation then
    raise exception 'you already have a booking at that time' using errcode = '22023';
  end;
  perform private.booking_notify(v, true, 'Booking accepted', 'Pay to confirm your booking for ' || v.title_snapshot || '.', 'accepted');
end;
$$;

create or replace function public.booking_propose(p_booking_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_note text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v        public.bookings := private.my_booking(p_booking_id, 'seller');
  v_period tstzrange;
begin
  if v.status not in ('requested', 'proposed') then
    raise exception 'this booking is % and cannot be changed', v.status using errcode = '22023';
  end if;
  v_period := private.check_booking_period(p_starts_at, p_ends_at);
  if exists (select 1 from public.bookings b where b.seller_profile_id = v.seller_profile_id and b.id <> v.id
             and b.status in ('accepted', 'confirmed') and b.period && v_period) then
    raise exception 'you already have a booking at that time' using errcode = '22023';
  end if;
  update public.bookings set period = v_period where id = p_booking_id;
  perform private.booking_transition(p_booking_id, 'proposed', nullif(btrim(p_note), ''));
  perform private.booking_notify(v, true, 'New time proposed', 'The seller proposed another time for ' || v.title_snapshot || '.', 'proposed:' || now()::text);
end;
$$;

-- The buyer agrees to the proposed time: back to the seller to accept with a price.
create or replace function public.booking_accept_proposal(p_booking_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.bookings := private.my_booking(p_booking_id, 'buyer');
begin
  if v.status <> 'proposed' then
    raise exception 'there is no proposed time to accept' using errcode = '22023';
  end if;
  if lower(v.period) < now() then
    raise exception 'the proposed time has passed' using errcode = '22023';
  end if;
  perform private.booking_transition(p_booking_id, 'requested', 'Buyer agreed to the proposed time');
  perform private.booking_notify(v, false, 'Proposed time agreed', 'The buyer agreed to your proposed time. Accept the booking to confirm the price.', 'agreed:' || now()::text);
end;
$$;

create or replace function public.booking_decline(p_booking_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.bookings := private.my_booking(p_booking_id, 'seller');
begin
  if v.status not in ('requested', 'proposed') then
    raise exception 'this booking is % and cannot be declined', v.status using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'give the buyer a reason (3 to 500 characters)' using errcode = '22023';
  end if;
  perform private.booking_transition(p_booking_id, 'declined', btrim(p_reason));
  perform private.booking_notify(v, true, 'Booking declined', 'The seller could not take this booking.', 'declined');
end;
$$;

create or replace function public.booking_complete(p_booking_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.bookings := private.my_booking(p_booking_id, 'seller');
begin
  if v.status <> 'confirmed' then
    raise exception 'only a confirmed booking can be completed' using errcode = '22023';
  end if;
  if lower(v.period) > now() then
    raise exception 'a booking is completed after it starts' using errcode = '22023';
  end if;
  perform private.booking_transition(p_booking_id, 'completed', null);
  perform private.booking_notify(v, true, 'Booking completed', 'The seller marked your booking as done.', 'completed');
end;
$$;

-- Either side cancels. A paid booking is refunded in full (no cancellation
-- fee is applied: decision D6).
create or replace function public.booking_cancel(p_booking_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v         public.bookings := private.my_booking(p_booking_id, 'either');
  v_buyer   boolean := v.buyer_user_id = private.current_active_user_id();
  v_payment uuid;
begin
  if v.status not in ('requested', 'proposed', 'accepted', 'confirmed') then
    raise exception 'this booking is % and cannot be cancelled', v.status using errcode = '22023';
  end if;
  if v.status = 'confirmed' and upper(v.period) < now() then
    raise exception 'this booking has already taken place; open a dispute instead' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'give a reason (3 to 500 characters)' using errcode = '22023';
  end if;
  perform private.booking_transition(p_booking_id, 'cancelled', btrim(p_reason));
  if v.status = 'confirmed' then
    select p.id into v_payment from public.payments p where p.booking_id = p_booking_id and p.status = 'succeeded' and p.failure_code is null limit 1;
    if v_payment is not null then
      perform private.create_refund(v_payment, null, v.amount_minor, 'Refund: booking cancelled', 'automatic');
    end if;
  end if;
  perform private.booking_notify(v, not v_buyer, 'Booking cancelled',
    case when v.status = 'confirmed' then 'This booking was cancelled. A full refund has been started.' else 'This booking was cancelled.' end,
    'cancelled');
  perform private.record_audit_event(v.community_id, 'booking.cancelled', 'booking', p_booking_id,
    jsonb_build_object('by_buyer', v_buyer, 'was', v.status));
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment (service role, from payments-session)
-- ---------------------------------------------------------------------------
create or replace function public.payment_begin_booking(p_user_id uuid, p_booking_id uuid, p_provider text, p_mode text)
returns table (payment_id uuid, amount_minor bigint, currency text, provider_reference text, redirect_url text,
               session_expires_at timestamptz, description text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v         public.bookings;
  v_payment public.payments;
begin
  select * into v from public.bookings b where b.id = p_booking_id for update;
  if v.id is null or v.buyer_user_id is distinct from p_user_id
     or not exists (select 1 from public.memberships m where m.community_id = v.community_id and m.user_id = p_user_id and m.status = 'active') then
    raise exception 'booking not found' using errcode = 'P0002';
  end if;
  if v.status <> 'accepted' then
    raise exception 'this booking cannot be paid (%)', v.status using errcode = '22023';
  end if;
  if v.payment_due_at <= now() then
    raise exception 'the time to pay for this booking has ended' using errcode = '22023';
  end if;
  select * into v_payment from public.payments p
  where p.booking_id = p_booking_id and p.status in ('pending', 'requires_action') and p.provider = p_provider
    and p.provider_reference is not null and (p.session_expires_at is null or p.session_expires_at > now() + interval '1 minute')
  order by p.created_at desc limit 1;
  if v_payment.id is null then
    insert into public.payments (community_id, booking_id, payer_user_id, provider, mode, amount_minor, currency)
    values (v.community_id, p_booking_id, p_user_id, p_provider, p_mode, v.amount_minor, v.currency)
    returning * into v_payment;
    insert into public.payment_events (payment_id, source, status, amount_minor, currency, outcome)
    values (v_payment.id, 'session', 'pending', v_payment.amount_minor, v_payment.currency, 'created');
  end if;
  return query select v_payment.id, v_payment.amount_minor, v_payment.currency::text, v_payment.provider_reference,
                      v_payment.redirect_url, v_payment.session_expires_at, 'CommuniOne booking ' || left(p_booking_id::text, 8);
end;
$$;

-- Replaces the Stage E placeholder: a confirmed payment confirms the booking.
create or replace function private.settle_paid_booking(p_booking_id uuid, p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v       public.bookings;
  v_pay   public.payments;
begin
  select * into v from public.bookings where id = p_booking_id for update;
  select * into v_pay from public.payments where id = p_payment_id;
  if v.status = 'confirmed' or exists (select 1 from public.payments p where p.booking_id = p_booking_id and p.id <> p_payment_id
                                       and p.status = 'succeeded' and p.failure_code is null) then
    -- Paid twice: the second payment is platform money until it is refunded.
    update public.payments set failure_code = 'duplicate_payment' where id = p_payment_id;
    perform private.post_ledger('payment_captured', 'payment', p_payment_id, v.community_id, v_pay.currency,
      jsonb_build_array(jsonb_build_object('account', 'platform_clearing', 'owner', null, 'amount_minor', v_pay.amount_minor),
                        jsonb_build_object('account', 'platform_revenue', 'owner', null, 'amount_minor', -v_pay.amount_minor)));
    perform private.create_refund(p_payment_id, null, v_pay.amount_minor, 'Automatic refund: this booking was already paid', 'automatic');
    return;
  end if;
  perform private.post_ledger('payment_captured', 'payment', p_payment_id, v.community_id, v_pay.currency,
    jsonb_build_array(jsonb_build_object('account', 'platform_clearing', 'owner', null, 'amount_minor', v_pay.amount_minor),
                      jsonb_build_object('account', 'seller_payable', 'owner', v.seller_user_id, 'amount_minor', -v_pay.amount_minor)));
  if v.status <> 'accepted' then
    -- Paid after the booking expired or was cancelled: refunded in full.
    perform private.create_refund(p_payment_id, null, v_pay.amount_minor,
      'Automatic refund: the booking was no longer open when the payment arrived', 'automatic');
    perform private.booking_notify(v, true, 'Payment received, booking no longer open',
      'Your payment arrived after the booking closed. A full refund has been started.', 'late:' || p_payment_id);
    return;
  end if;
  perform private.booking_transition(p_booking_id, 'confirmed', 'Payment confirmed');
  perform private.booking_notify(v, true, 'Booking confirmed', 'Your payment was confirmed.', 'confirmed');
  perform private.booking_notify(v, false, 'Booking confirmed', 'The buyer paid. The booking is confirmed.', 'confirmed');
end;
$$;

revoke all on function private.settle_paid_booking(uuid, uuid) from public, anon, authenticated, service_role;

-- create_refund also records the booking's seller.
create or replace function private.create_refund(
  p_payment_id uuid, p_order_id uuid, p_amount_minor bigint, p_reason text, p_kind text,
  p_status text default 'approved', p_requested_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_seller  uuid;
  v_used    bigint;
  v_id      uuid;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null or v_payment.status <> 'succeeded' then
    raise exception 'only a successful payment can be refunded' using errcode = '22023';
  end if;
  select coalesce(sum(amount_minor), 0) into v_used from public.refunds
  where payment_id = p_payment_id and status not in ('rejected', 'failed');
  if p_amount_minor is null or p_amount_minor <= 0 or v_used + p_amount_minor > v_payment.amount_minor then
    raise exception 'refunds cannot exceed the amount paid (% of % already refunded or in progress)', v_used, v_payment.amount_minor
      using errcode = '22023';
  end if;
  if p_order_id is not null then
    select seller_user_id into v_seller from public.orders where id = p_order_id;
  elsif v_payment.booking_id is not null then
    select seller_user_id into v_seller from public.bookings where id = v_payment.booking_id;
  end if;
  insert into public.refunds (community_id, payment_id, order_id, booking_id, buyer_user_id, seller_user_id, kind, requested_by,
                              reason, amount_minor, currency, status)
  values (v_payment.community_id, p_payment_id, p_order_id, v_payment.booking_id, v_payment.payer_user_id, v_seller,
          p_kind, p_requested_by, p_reason, p_amount_minor, v_payment.currency, p_status)
  returning id into v_id;
  insert into public.refund_events (refund_id, from_status, to_status, actor_user_id, note)
  values (v_id, null, p_status, private.actor_user_id(), p_reason);
  return v_id;
end;
$$;

revoke all on function private.create_refund(uuid, uuid, bigint, text, text, text, uuid) from public, anon, authenticated, service_role;

-- Refund ledger: from the seller's balance, except refunds of duplicate
-- payments, which were never the seller's (platform revenue).
create or replace function public.refund_apply_result(p_refund_id uuid, p_status text, p_provider_reference text, p_failure_code text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_refund   public.refunds;
  v_payment  public.payments;
  v_refunded bigint;
begin
  if p_status not in ('succeeded', 'pending', 'failed', 'retry') then
    raise exception 'unknown refund result %', p_status using errcode = '22023';
  end if;
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if v_refund.id is null then
    raise exception 'refund not found' using errcode = 'P0002';
  end if;
  if v_refund.status in ('succeeded', 'rejected') then
    return 'ignored';
  end if;
  update public.refunds set provider_refund_reference = coalesce(p_provider_reference, provider_refund_reference) where id = p_refund_id;

  if p_status = 'retry' then
    perform private.refund_transition(p_refund_id, 'approved', 'Provider unavailable; will retry');
    return 'retry';
  elsif p_status = 'pending' then
    perform private.refund_transition(p_refund_id, 'pending', null);
    return 'pending';
  elsif p_status = 'failed' then
    update public.refunds set failure_code = left(coalesce(p_failure_code, 'failed'), 80) where id = p_refund_id;
    perform private.refund_transition(p_refund_id, 'failed', p_failure_code);
    perform private.record_audit_event(v_refund.community_id, 'refund.failed', 'refund', p_refund_id,
      jsonb_build_object('failure_code', p_failure_code));
    return 'failed';
  end if;

  update public.refunds set succeeded_at = now(), failure_code = null where id = p_refund_id;
  perform private.refund_transition(p_refund_id, 'succeeded', null);
  select * into v_payment from public.payments where id = v_refund.payment_id;
  perform private.post_ledger('refund', 'refund', p_refund_id, v_refund.community_id, v_refund.currency,
    jsonb_build_array(
      jsonb_build_object('account', 'platform_clearing', 'owner', null, 'amount_minor', -v_refund.amount_minor),
      case when v_payment.failure_code is distinct from 'duplicate_payment' and v_refund.seller_user_id is not null
           then jsonb_build_object('account', 'seller_payable', 'owner', v_refund.seller_user_id, 'amount_minor', v_refund.amount_minor)
           else jsonb_build_object('account', 'platform_revenue', 'owner', null, 'amount_minor', v_refund.amount_minor) end));
  if v_payment.checkout_id is not null and v_payment.failure_code is null then
    select coalesce(sum(amount_minor), 0) into v_refunded from public.refunds where payment_id = v_payment.id and status = 'succeeded';
    update public.checkouts set status = case when v_refunded >= v_payment.amount_minor then 'refunded' else 'partially_refunded' end
    where id = v_payment.checkout_id and status in ('paid', 'partially_refunded');
  end if;
  perform private.record_audit_event(v_refund.community_id, 'refund.succeeded', 'refund', p_refund_id,
    jsonb_build_object('amount_minor', v_refund.amount_minor));
  if v_refund.buyer_user_id is not null then
    perform private.create_notification(v_refund.buyer_user_id, v_refund.community_id, 'refund', 'Refund completed',
      'The payment provider has processed your refund. It may take a few days to appear on your statement.',
      jsonb_build_object('order_id', v_refund.order_id, 'booking_id', v_refund.booking_id, 'refund_id', p_refund_id),
      'refund:' || p_refund_id || ':succeeded');
  end if;
  return 'succeeded';
end;
$$;

-- ---------------------------------------------------------------------------
-- Disputes about bookings (decided like order disputes)
-- ---------------------------------------------------------------------------
create or replace function public.booking_dispute_open(p_booking_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v    public.bookings := private.my_booking(p_booking_id, 'buyer');
  v_id uuid;
begin
  if v.status not in ('confirmed', 'completed', 'cancelled') or not exists (
       select 1 from public.payments p where p.booking_id = p_booking_id and p.status = 'succeeded' and p.failure_code is null) then
    raise exception 'only a paid booking can be disputed' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 2000 then
    raise exception 'describe the problem (10 to 2000 characters)' using errcode = '22023';
  end if;
  if exists (select 1 from public.disputes d where d.booking_id = p_booking_id and d.status = 'open') then
    raise exception 'this booking already has an open dispute' using errcode = '22023';
  end if;
  perform private.enforce_rate_limit('dispute.open');
  insert into public.disputes (community_id, booking_id, buyer_user_id, seller_user_id, reason)
  values (v.community_id, p_booking_id, v.buyer_user_id, v.seller_user_id, btrim(p_reason))
  returning id into v_id;
  perform private.record_audit_event(v.community_id, 'dispute.opened', 'dispute', v_id, jsonb_build_object('booking_id', p_booking_id));
  perform private.booking_notify(v, false, 'A buyer opened a dispute', 'A community marketplace manager will review it.', 'dispute:' || v_id);
  return v_id;
end;
$$;

-- dispute_resolve now finds the payment of an order or of a booking.
create or replace function public.dispute_resolve(p_dispute_id uuid, p_refund boolean, p_amount_minor bigint, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me      uuid := private.current_active_user_id();
  v_dispute public.disputes;
  v_payment uuid;
  v_refund  uuid;
begin
  select * into v_dispute from public.disputes where id = p_dispute_id for update;
  if v_me is null or v_dispute.id is null or not public.has_community_permission(v_dispute.community_id, 'marketplace.manage') then
    raise exception 'dispute not found' using errcode = 'P0002';
  end if;
  if v_me in (v_dispute.buyer_user_id, v_dispute.seller_user_id) then
    raise exception 'a party to the dispute cannot decide it' using errcode = '42501';
  end if;
  if v_dispute.status <> 'open' then
    raise exception 'this dispute is already closed' using errcode = '22023';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 3 and 1000 then
    raise exception 'explain the decision (3 to 1000 characters)' using errcode = '22023';
  end if;
  if p_refund then
    if v_dispute.order_id is not null then
      select p.id into v_payment from public.payments p join public.orders o on o.checkout_id = p.checkout_id
      where o.id = v_dispute.order_id and p.status = 'succeeded' and p.failure_code is null limit 1;
      perform private.refund_transition(r.id, 'rejected', 'Superseded by dispute decision')
      from public.refunds r where r.order_id = v_dispute.order_id and r.status = 'requested';
    else
      select p.id into v_payment from public.payments p
      where p.booking_id = v_dispute.booking_id and p.status = 'succeeded' and p.failure_code is null limit 1;
    end if;
    if v_payment is null then
      raise exception 'there is no captured payment to refund' using errcode = '22023';
    end if;
    v_refund := private.create_refund(v_payment, v_dispute.order_id, p_amount_minor, 'Dispute decision: ' || btrim(p_note), 'dispute', 'approved', v_me);
  end if;
  update public.disputes
  set status = case when p_refund then 'resolved_refund' else 'resolved_no_refund' end,
      resolution_note = btrim(p_note), resolved_by = v_me, resolved_at = now(), refund_id = v_refund
  where id = p_dispute_id;
  perform private.record_audit_event(v_dispute.community_id, 'dispute.resolved', 'dispute', p_dispute_id,
    jsonb_build_object('refund', p_refund, 'amount_minor', case when p_refund then p_amount_minor end));
  perform private.create_notification(u, v_dispute.community_id, 'dispute', 'Dispute decided',
      'A community marketplace manager decided the dispute. Open it to see the decision.',
      jsonb_build_object('dispute_id', p_dispute_id), 'dispute:' || p_dispute_id || ':resolved:' || u)
  from unnest(array[v_dispute.buyer_user_id, v_dispute.seller_user_id]) u where u is not null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Jobs (service role; run from payments-reconcile)
-- ---------------------------------------------------------------------------
create or replace function public.expire_unpaid_bookings()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v       public.bookings;
  v_count integer := 0;
begin
  for v in
    select * from public.bookings
    where (status = 'accepted' and payment_due_at <= now())
       or (status in ('requested', 'proposed') and lower(period) <= now())
    order by id for update skip locked
  loop
    perform private.booking_transition(v.id, 'expired', case when v.status = 'accepted' then 'Not paid in time' else 'Not answered in time' end);
    perform private.booking_notify(v, true, 'Booking expired', 'This booking was not completed in time and has been released.', 'expired');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.complete_past_bookings(p_after interval default interval '3 days')
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_count integer := 0;
begin
  for v_id in
    select id from public.bookings where status = 'confirmed' and upper(period) < now() - p_after
    order by id for update skip locked
  loop
    perform private.booking_transition(v_id, 'completed', 'Completed automatically after the booking');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on function public.service_availability_save(uuid, jsonb)                        from public, anon, authenticated;
revoke all on function public.service_time_off_add(uuid, timestamptz, timestamptz, text)     from public, anon, authenticated;
revoke all on function public.booking_request(uuid, timestamptz, timestamptz, text, text)    from public, anon, authenticated;
revoke all on function public.booking_accept(uuid, bigint)                                   from public, anon, authenticated;
revoke all on function public.booking_propose(uuid, timestamptz, timestamptz, text)          from public, anon, authenticated;
revoke all on function public.booking_accept_proposal(uuid)                                  from public, anon, authenticated;
revoke all on function public.booking_decline(uuid, text)                                    from public, anon, authenticated;
revoke all on function public.booking_complete(uuid)                                         from public, anon, authenticated;
revoke all on function public.booking_cancel(uuid, text)                                     from public, anon, authenticated;
revoke all on function public.booking_dispute_open(uuid, text)                               from public, anon, authenticated;
revoke all on function public.payment_begin_booking(uuid, uuid, text, text)                  from public, anon, authenticated;
revoke all on function public.expire_unpaid_bookings()                                       from public, anon, authenticated;
revoke all on function public.complete_past_bookings(interval)                               from public, anon, authenticated;
grant execute on function public.service_availability_save(uuid, jsonb)                     to authenticated;
grant execute on function public.service_time_off_add(uuid, timestamptz, timestamptz, text)  to authenticated;
grant execute on function public.booking_request(uuid, timestamptz, timestamptz, text, text) to authenticated;
grant execute on function public.booking_accept(uuid, bigint)                                to authenticated;
grant execute on function public.booking_propose(uuid, timestamptz, timestamptz, text)       to authenticated;
grant execute on function public.booking_accept_proposal(uuid)                               to authenticated;
grant execute on function public.booking_decline(uuid, text)                                 to authenticated;
grant execute on function public.booking_complete(uuid)                                      to authenticated;
grant execute on function public.booking_cancel(uuid, text)                                  to authenticated;
grant execute on function public.booking_dispute_open(uuid, text)                            to authenticated;
grant execute on function public.payment_begin_booking(uuid, uuid, text, text)               to service_role;
grant execute on function public.expire_unpaid_bookings()                                    to service_role;
grant execute on function public.complete_past_bookings(interval)                            to service_role;

revoke all on table public.service_availability, public.service_time_off, public.bookings, public.booking_events from public, anon, authenticated;
grant all on table public.service_availability, public.service_time_off, public.bookings, public.booking_events to service_role;
alter table public.service_availability enable row level security;
alter table public.service_time_off     enable row level security;
alter table public.bookings             enable row level security;
alter table public.booking_events       enable row level security;

-- Weekly hours are public to the community (buyers pick a time); time off
-- shows only as busy periods through the seller's own view.
grant select on public.service_availability to authenticated;
create policy service_availability_select_members on public.service_availability
  for select to authenticated using (public.has_community_permission(community_id, 'marketplace.view'));
grant select on public.service_time_off to authenticated;
create policy service_time_off_select_owner on public.service_time_off
  for select to authenticated
  using (exists (select 1 from public.seller_profiles s where s.id = seller_profile_id and s.user_id = (select private.current_active_user_id())));

grant select on public.bookings, public.booking_events to authenticated;
create policy bookings_select_parties on public.bookings
  for select to authenticated
  using (buyer_user_id = (select private.current_active_user_id()) or seller_user_id = (select private.current_active_user_id()));
create policy booking_events_select_parties on public.booking_events
  for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id
                 and (b.buyer_user_id = (select private.current_active_user_id()) or b.seller_user_id = (select private.current_active_user_id()))));

-- Busy times (no details) so buyers can avoid them.
create or replace function public.seller_busy_times(p_seller_profile_id uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select lower(x.period), upper(x.period) from (
    select b.period from public.bookings b
    where b.seller_profile_id = p_seller_profile_id and b.status in ('accepted', 'confirmed') and b.period && tstzrange(p_from, p_to)
    union all
    select t.period from public.service_time_off t
    where t.seller_profile_id = p_seller_profile_id and t.period && tstzrange(p_from, p_to)
  ) x
  where exists (select 1 from public.seller_profiles s where s.id = p_seller_profile_id
                and public.has_community_permission(s.community_id, 'marketplace.view'))
    and p_to > p_from and p_to - p_from <= interval '62 days'
  order by 1;
$$;

revoke all on function public.seller_busy_times(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.seller_busy_times(uuid, timestamptz, timestamptz) to authenticated;

insert into private.rate_limit_rules (action, max_count, window_seconds, description) values
  ('booking.request', 20, 3600, 'Booking requests per user per hour')
on conflict (action) do nothing;

insert into public.audit_actions (action, entity_type, description) values
  ('booking.cancelled', 'booking', 'A service booking was cancelled')
on conflict (action) do nothing;
