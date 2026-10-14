-- Marketplace Stages G-H / Migration 36: seller fulfillment, delivery and
-- pickup (see docs/commerce/lifecycles.md).
--
-- Seller order steps (each its own function, each re-checked here):
--   paid ──accept──> accepted ──start──> processing
--   accepted|processing ──ready (pickup)──> ready_for_pickup ──code──> completed
--   accepted|processing ──dispatch (delivery)──> out_for_delivery
--   out_for_delivery ──delivered──> delivered ──buyer confirms / 7 days──> completed
--   out_for_delivery ──failed──> delivery_failed ──dispatch──> out_for_delivery
--   paid ──reject──> rejected                       (full refund, stock back)
--   accepted..delivery_failed ──seller cancels──> cancelled (full refund, stock back)
--   paid ──buyer cancels──> cancelled              (full refund, stock back)
--   paid, not accepted in 48 hours ──job──> cancelled (full refund, stock back)
--
-- Delivery tracking is ONLY what the seller records (courier name, a
-- tracking reference/link they were given). Nothing is invented: no GPS,
-- no estimated arrival beyond the seller's own estimate at checkout.
--
-- Pickup: the buyer gets a 6-digit code once the order is ready; the seller
-- completes the handover by entering it (5 wrong attempts lock it).
--
-- Refunds created here are refund RECORDS (status approved). They are sent
-- to the payment provider by the refunds-process function (Stage I).

-- ---------------------------------------------------------------------------
-- Shipments: what the seller recorded about a delivery
-- ---------------------------------------------------------------------------
create table public.order_shipments (
  order_id           uuid primary key references public.orders (id) on delete restrict,
  courier_name       text check (char_length(courier_name) between 1 and 80),
  tracking_reference text check (char_length(tracking_reference) between 1 and 120),
  tracking_url       text check (char_length(tracking_url) <= 500 and tracking_url ~ '^https://[^\s]{4,}$'),
  dispatched_at      timestamptz,
  delivered_at       timestamptz,
  failed_at          timestamptz,
  failure_reason     text check (char_length(failure_reason) <= 500),
  attempts           integer not null default 0 check (attempts >= 0),
  updated_at         timestamptz not null default now()
);

create trigger order_shipments_set_updated_at
  before update on public.order_shipments
  for each row execute function private.set_updated_at();

-- Pickup codes: the buyer's proof at handover. Readable by the buyer only.
create table public.order_pickup_codes (
  order_id        uuid primary key references public.orders (id) on delete restrict,
  code            text not null check (code ~ '^[0-9]{6}$'),
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);

alter table public.orders
  add column accepted_at  timestamptz,
  add column completed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The caller's order as its seller, locked; NotFound otherwise.
create or replace function private.seller_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null or v_order.seller_user_id is distinct from private.current_active_user_id()
     or not private.can_view_order(p_order_id) then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if not public.has_community_permission(v_order.community_id, 'marketplace.sell') then
    raise exception 'marketplace.sell is required in this community' using errcode = '42501';
  end if;
  return v_order;
end;
$$;

revoke all on function private.seller_order(uuid) from public, anon, authenticated, service_role;

create or replace function private.require_order_status(p_order public.orders, p_allowed text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if not (p_order.status = any (p_allowed)) then
    raise exception 'this order is % and cannot do that', replace(p_order.status, '_', ' ') using errcode = '22023';
  end if;
end;
$$;

revoke all on function private.require_order_status(public.orders, text[]) from public, anon, authenticated, service_role;

create or replace function private.notify_buyer(p_order public.orders, p_title text, p_body text, p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_order.buyer_user_id is not null then
    perform private.create_notification(p_order.buyer_user_id, p_order.community_id, 'order', p_title, p_body,
      jsonb_build_object('order_id', p_order.id), 'order:' || p_order.id || ':' || p_key);
  end if;
end;
$$;

revoke all on function private.notify_buyer(public.orders, text, text, text) from public, anon, authenticated, service_role;

-- Puts an order's items back in stock (rejection or cancellation after payment).
create or replace function private.restock_order(p_order_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
begin
  for v_item in
    select oi.listing_id, sum(oi.quantity)::integer as quantity, o.community_id
    from public.order_items oi join public.orders o on o.id = oi.order_id
    where oi.order_id = p_order_id and oi.listing_id is not null
    group by oi.listing_id, o.community_id
    order by oi.listing_id
  loop
    update public.inventory set on_hand = on_hand + v_item.quantity, updated_at = now() where listing_id = v_item.listing_id;
    insert into public.inventory_movements (listing_id, community_id, delta, on_hand_after, reason, note, actor_user_id)
    select v_item.listing_id, v_item.community_id, v_item.quantity, i.on_hand, 'return', p_note, private.actor_user_id()
    from public.inventory i where i.listing_id = v_item.listing_id;
  end loop;
end;
$$;

revoke all on function private.restock_order(uuid, text) from public, anon, authenticated, service_role;

-- A full refund record for one paid order (whatever is not refunded yet).
create or replace function private.refund_order_in_full(p_order_id uuid, p_reason text, p_requested_by uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders;
  v_payment uuid;
  v_done    bigint;
begin
  select * into v_order from public.orders where id = p_order_id;
  select p.id into v_payment from public.payments p
  where p.checkout_id = v_order.checkout_id and p.status = 'succeeded' and p.failure_code is null
  limit 1;
  if v_payment is null then
    return null; -- never paid: nothing to refund
  end if;
  select coalesce(sum(amount_minor), 0) into v_done from public.refunds
  where order_id = p_order_id and status not in ('rejected', 'failed');
  if v_order.total_minor - v_done <= 0 then
    return null;
  end if;
  return private.create_refund(v_payment, p_order_id, v_order.total_minor - v_done, p_reason, 'automatic', 'approved', p_requested_by);
end;
$$;

revoke all on function private.refund_order_in_full(uuid, text, uuid) from public, anon, authenticated, service_role;

-- Cancels a paid order: status, stock back, full refund, both told.
create or replace function private.cancel_paid_order(p_order public.orders, p_to text, p_reason text, p_by_buyer boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.order_transition(p_order.id, p_to, p_reason);
  perform private.restock_order(p_order.id, 'order ' || p_order.id || ' ' || p_to);
  perform private.refund_order_in_full(p_order.id, 'Refund: ' || p_reason);
  update public.order_pickup_codes set used_at = coalesce(used_at, now()) where order_id = p_order.id;
  perform private.notify_buyer(p_order,
    case when p_to = 'rejected' then 'Order declined by the seller' else 'Order cancelled' end,
    'A full refund has been started. It reaches you once the payment provider processes it.', p_to);
  if p_by_buyer and p_order.seller_user_id is not null then
    perform private.create_notification(p_order.seller_user_id, p_order.community_id, 'order', 'Order cancelled by the buyer',
      'Do not prepare or send this order. The items are back in stock.',
      jsonb_build_object('order_id', p_order.id), 'order:' || p_order.id || ':buyer_cancelled');
  end if;
  perform private.record_audit_event(p_order.community_id, 'order.cancelled', 'order', p_order.id,
    jsonb_build_object('to', p_to, 'by_buyer', p_by_buyer));
end;
$$;

revoke all on function private.cancel_paid_order(public.orders, text, text, boolean) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Seller steps
-- ---------------------------------------------------------------------------
create or replace function public.order_accept(p_order_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.seller_order(p_order_id);
begin
  perform private.require_order_status(v_order, array['paid']);
  update public.orders set accepted_at = now() where id = p_order_id;
  perform private.order_transition(p_order_id, 'accepted', null);
  perform private.notify_buyer(v_order, 'Order accepted', v_order.seller_name || ' accepted your order.', 'accepted');
end;
$$;

create or replace function public.order_reject(p_order_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.seller_order(p_order_id);
begin
  perform private.require_order_status(v_order, array['paid']);
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'give the buyer a reason (3 to 500 characters)' using errcode = '22023';
  end if;
  perform private.cancel_paid_order(v_order, 'rejected', btrim(p_reason), false);
end;
$$;

create or replace function public.order_start_processing(p_order_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.seller_order(p_order_id);
begin
  perform private.require_order_status(v_order, array['accepted']);
  perform private.order_transition(p_order_id, 'processing', null);
end;
$$;

-- Pickup orders: ready, with a fresh code for the buyer.
create or replace function public.order_ready_for_pickup(p_order_id uuid, p_note text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.seller_order(p_order_id);
begin
  perform private.require_order_status(v_order, array['accepted', 'processing']);
  if v_order.fulfillment_method <> 'pickup' then
    raise exception 'this order is delivered, not picked up' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    raise exception 'the pickup note is too long' using errcode = '22023';
  end if;
  insert into public.order_pickup_codes (order_id, code)
  values (p_order_id, lpad((floor(random() * 1000000))::int::text, 6, '0'))
  on conflict (order_id) do nothing;
  perform private.order_transition(p_order_id, 'ready_for_pickup', nullif(btrim(p_note), ''));
  perform private.notify_buyer(v_order, 'Ready for pickup',
    v_order.seller_name || ' has your order ready. Show your pickup code when you collect it.', 'ready');
end;
$$;

-- The seller enters the buyer's code at handover. Returns 'completed', or
-- 'wrong_code' (the failed attempt is kept, so it cannot raise).
create or replace function public.order_confirm_pickup(p_order_id uuid, p_code text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.seller_order(p_order_id);
  v_code  public.order_pickup_codes;
begin
  perform private.require_order_status(v_order, array['ready_for_pickup']);
  select * into v_code from public.order_pickup_codes where order_id = p_order_id for update;
  if v_code.order_id is null or v_code.used_at is not null then
    raise exception 'this order has no active pickup code' using errcode = '22023';
  end if;
  if v_code.failed_attempts >= 5 then
    raise exception 'too many wrong codes; ask a community admin for help' using errcode = '22023';
  end if;
  if p_code is null or btrim(p_code) <> v_code.code then
    update public.order_pickup_codes set failed_attempts = failed_attempts + 1 where order_id = p_order_id;
    return 'wrong_code';
  end if;
  update public.order_pickup_codes set used_at = now() where order_id = p_order_id;
  update public.orders set completed_at = now() where id = p_order_id;
  perform private.order_transition(p_order_id, 'completed', 'Collected');
  perform private.notify_buyer(v_order, 'Order collected', 'Thank you. Your order is complete.', 'completed');
  return 'completed';
end;
$$;

-- Delivery orders: the seller sends it, optionally with a courier's details.
create or replace function public.order_dispatch(
  p_order_id uuid, p_courier_name text default null, p_tracking_reference text default null, p_tracking_url text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.seller_order(p_order_id);
begin
  perform private.require_order_status(v_order, array['accepted', 'processing', 'delivery_failed']);
  if v_order.fulfillment_method <> 'seller_delivery' then
    raise exception 'this order is picked up, not delivered' using errcode = '22023';
  end if;
  if p_tracking_url is not null and (char_length(p_tracking_url) > 500 or p_tracking_url !~ '^https://[^\s]{4,}$') then
    raise exception 'a tracking link must start with https://' using errcode = '22023';
  end if;
  insert into public.order_shipments (order_id, courier_name, tracking_reference, tracking_url, dispatched_at, attempts)
  values (p_order_id, nullif(btrim(p_courier_name), ''), nullif(btrim(p_tracking_reference), ''), p_tracking_url, now(), 1)
  on conflict (order_id) do update
    set courier_name = excluded.courier_name, tracking_reference = excluded.tracking_reference,
        tracking_url = excluded.tracking_url, dispatched_at = now(), failed_at = null, failure_reason = null,
        attempts = public.order_shipments.attempts + 1;
  perform private.order_transition(p_order_id, 'out_for_delivery', null);
  perform private.notify_buyer(v_order, 'Out for delivery', v_order.seller_name || ' has sent your order.',
    'dispatched:' || (select attempts from public.order_shipments where order_id = p_order_id));
end;
$$;

create or replace function public.order_mark_delivered(p_order_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.seller_order(p_order_id);
begin
  perform private.require_order_status(v_order, array['out_for_delivery']);
  update public.order_shipments set delivered_at = now() where order_id = p_order_id;
  perform private.order_transition(p_order_id, 'delivered', null);
  perform private.notify_buyer(v_order, 'Delivered',
    'The seller says your order was delivered. Confirm you received it, or report a problem.', 'delivered');
end;
$$;

create or replace function public.order_mark_delivery_failed(p_order_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.seller_order(p_order_id);
begin
  perform private.require_order_status(v_order, array['out_for_delivery']);
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'say what went wrong (3 to 500 characters)' using errcode = '22023';
  end if;
  update public.order_shipments set failed_at = now(), failure_reason = btrim(p_reason) where order_id = p_order_id;
  perform private.order_transition(p_order_id, 'delivery_failed', btrim(p_reason));
  perform private.notify_buyer(v_order, 'Delivery attempt failed', 'The seller could not deliver your order. They will contact you.', 'failed:' || now()::text);
end;
$$;

-- The seller cannot complete an order they accepted: cancelled with a full refund.
create or replace function public.order_seller_cancel(p_order_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.seller_order(p_order_id);
begin
  perform private.require_order_status(v_order, array['accepted', 'processing', 'ready_for_pickup', 'delivery_failed']);
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'give the buyer a reason (3 to 500 characters)' using errcode = '22023';
  end if;
  perform private.cancel_paid_order(v_order, 'cancelled', btrim(p_reason), false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Buyer steps
-- ---------------------------------------------------------------------------
create or replace function private.buyer_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null or v_order.buyer_user_id is distinct from private.current_active_user_id() then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  return v_order;
end;
$$;

revoke all on function private.buyer_order(uuid) from public, anon, authenticated, service_role;

-- Before the seller accepts, the buyer may cancel for a full refund.
create or replace function public.order_buyer_cancel(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.buyer_order(p_order_id);
begin
  perform private.require_order_status(v_order, array['paid']);
  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception 'the reason is too long' using errcode = '22023';
  end if;
  perform private.cancel_paid_order(v_order, 'cancelled', coalesce(nullif(btrim(p_reason), ''), 'Cancelled by the buyer before acceptance'), true);
end;
$$;

create or replace function public.order_confirm_received(p_order_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders := private.buyer_order(p_order_id);
begin
  perform private.require_order_status(v_order, array['delivered']);
  update public.orders set completed_at = now() where id = p_order_id;
  perform private.order_transition(p_order_id, 'completed', 'Received by the buyer');
  if v_order.seller_user_id is not null then
    perform private.create_notification(v_order.seller_user_id, v_order.community_id, 'order', 'Order received',
      'The buyer confirmed they received the order.', jsonb_build_object('order_id', p_order_id), 'order:' || p_order_id || ':received');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Scheduled jobs (service role; run from payments-reconcile)
-- ---------------------------------------------------------------------------
-- Paid orders the seller did not accept in time: cancelled and refunded.
create or replace function public.expire_unaccepted_orders(p_after interval default interval '48 hours')
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_count integer := 0;
begin
  for v_order in
    select o.* from public.orders o
    join public.checkouts c on c.id = o.checkout_id
    where o.status = 'paid' and c.paid_at < now() - p_after
    order by o.id
    for update of o skip locked
  loop
    perform private.cancel_paid_order(v_order, 'cancelled', 'The seller did not accept the order in time', false);
    if v_order.seller_user_id is not null then
      perform private.create_notification(v_order.seller_user_id, v_order.community_id, 'order', 'Order cancelled',
        'You did not accept this order in time, so it was cancelled and the buyer refunded.',
        jsonb_build_object('order_id', v_order.id), 'order:' || v_order.id || ':expired');
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Delivered orders the buyer did not confirm or dispute: completed.
create or replace function public.complete_delivered_orders(p_after interval default interval '7 days')
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_count integer := 0;
begin
  for v_order in
    select o.* from public.orders o
    join public.order_shipments s on s.order_id = o.id
    where o.status = 'delivered' and s.delivered_at < now() - p_after
    order by o.id
    for update of o skip locked
  loop
    update public.orders set completed_at = now() where id = v_order.id;
    perform private.order_transition(v_order.id, 'completed', 'Completed automatically after delivery');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on function public.order_accept(uuid)                       from public, anon, authenticated;
revoke all on function public.order_reject(uuid, text)                 from public, anon, authenticated;
revoke all on function public.order_start_processing(uuid)             from public, anon, authenticated;
revoke all on function public.order_ready_for_pickup(uuid, text)       from public, anon, authenticated;
revoke all on function public.order_confirm_pickup(uuid, text)         from public, anon, authenticated;
revoke all on function public.order_dispatch(uuid, text, text, text)   from public, anon, authenticated;
revoke all on function public.order_mark_delivered(uuid)               from public, anon, authenticated;
revoke all on function public.order_mark_delivery_failed(uuid, text)   from public, anon, authenticated;
revoke all on function public.order_seller_cancel(uuid, text)          from public, anon, authenticated;
revoke all on function public.order_buyer_cancel(uuid, text)           from public, anon, authenticated;
revoke all on function public.order_confirm_received(uuid)             from public, anon, authenticated;
revoke all on function public.expire_unaccepted_orders(interval)       from public, anon, authenticated;
revoke all on function public.complete_delivered_orders(interval)      from public, anon, authenticated;
grant execute on function public.order_accept(uuid)                     to authenticated;
grant execute on function public.order_reject(uuid, text)               to authenticated;
grant execute on function public.order_start_processing(uuid)           to authenticated;
grant execute on function public.order_ready_for_pickup(uuid, text)     to authenticated;
grant execute on function public.order_confirm_pickup(uuid, text)       to authenticated;
grant execute on function public.order_dispatch(uuid, text, text, text) to authenticated;
grant execute on function public.order_mark_delivered(uuid)             to authenticated;
grant execute on function public.order_mark_delivery_failed(uuid, text) to authenticated;
grant execute on function public.order_seller_cancel(uuid, text)        to authenticated;
grant execute on function public.order_buyer_cancel(uuid, text)         to authenticated;
grant execute on function public.order_confirm_received(uuid)           to authenticated;
grant execute on function public.expire_unaccepted_orders(interval)     to service_role;
grant execute on function public.complete_delivered_orders(interval)    to service_role;

revoke all on table public.order_shipments, public.order_pickup_codes from public, anon, authenticated;
grant all on table public.order_shipments, public.order_pickup_codes to service_role;
alter table public.order_shipments    enable row level security;
alter table public.order_pickup_codes enable row level security;

grant select on public.order_shipments to authenticated;
create policy order_shipments_select_parties on public.order_shipments
  for select to authenticated using (private.can_view_order(order_id));

-- The code is the buyer's: the seller must hear it from them.
grant select (order_id, code, used_at, created_at) on public.order_pickup_codes to authenticated;
create policy order_pickup_codes_select_buyer on public.order_pickup_codes
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.buyer_user_id = (select private.current_active_user_id())));

insert into public.audit_actions (action, entity_type, description) values
  ('order.cancelled', 'order', 'A paid order was rejected or cancelled and refunded')
on conflict (action) do nothing;
