-- Marketplace Stages E-F / Migration 35: payments, webhooks, reconciliation,
-- refunds (records), the money ledger, and commerce notifications.
-- See docs/commerce/payments.md and lifecycles.md.
--
-- Trust model:
--   * The app never marks anything paid. Payments change ONLY through
--     public.payment_apply_event(), executable by the service role alone,
--     i.e. by the payments Edge Functions after they verified a provider
--     webhook signature or queried the provider's API (reconciliation).
--   * Amounts come from the database (checkout totals); a provider event
--     whose amount or currency differs is never accepted as paid.
--   * Webhook events are recorded once (provider, provider_event_id):
--     duplicates and replays are no-ops.
--   * No card data or provider secrets are stored: only references,
--     statuses, amounts and a SHA-256 of the raw provider payload.
--
-- Ledger: double-entry, append-only. Every transaction's entries sum to
-- zero. Debits are positive, credits negative. Accounts:
--   platform_clearing     money held at the payment provider for the platform
--   seller_payable/<user> what the platform owes a seller (decision D2-D7:
--                         payouts are not enabled; see Stage K)
--   platform_revenue      commission (0 until decision D4)
-- A refund that succeeds reverses the seller's share.

-- ---------------------------------------------------------------------------
-- Commerce notification types (personal; not tied to staying a member)
-- ---------------------------------------------------------------------------
insert into public.notification_types (key, description, requires_membership, default_priority) values
  ('order',    'A marketplace order you are part of changed',          false, 'high'),
  ('payment',  'A payment you made was confirmed or failed',           false, 'high'),
  ('refund',   'A refund on your order changed',                       false, 'high'),
  ('delivery', 'Pickup or delivery of your order changed',             false, 'normal'),
  ('booking',  'A service booking you are part of changed',            false, 'high'),
  ('dispute',  'A dispute you are part of was updated',                false, 'high')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
create table public.payments (
  id                 uuid primary key default gen_random_uuid(),
  community_id       uuid not null references public.communities (id) on delete restrict,
  checkout_id        uuid references public.checkouts (id) on delete restrict,
  -- Stage J: service bookings are paid too (foreign key added there).
  booking_id         uuid,
  payer_user_id      uuid references public.profiles (id) on delete set null,
  provider           text not null check (provider ~ '^[a-z][a-z0-9_]*$'),
  mode               text not null check (mode in ('test', 'sandbox', 'live')),
  provider_reference text,
  redirect_url       text check (char_length(redirect_url) <= 2048),
  session_expires_at timestamptz,
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null check (currency in ('JMD', 'USD')),
  status             text not null default 'pending'
                     check (status in ('pending', 'requires_action', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown')),
  failure_code       text check (char_length(failure_code) <= 80),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  confirmed_at       timestamptz,
  constraint payments_one_target check (num_nonnulls(checkout_id, booking_id) = 1),
  constraint payments_provider_reference_key unique (provider, provider_reference)
);

create index payments_checkout_idx on public.payments (checkout_id);
create index payments_open_idx on public.payments (updated_at) where status in ('pending', 'requires_action', 'unknown');
-- At most one successful payment per checkout (a second one is refunded).
create unique index payments_one_success_per_checkout on public.payments (checkout_id)
  where status = 'succeeded' and failure_code is null and checkout_id is not null;

create trigger payments_set_updated_at before update on public.payments
  for each row execute function private.set_updated_at();

create table public.payment_events (
  id                uuid primary key default gen_random_uuid(),
  payment_id        uuid not null references public.payments (id) on delete restrict,
  source            text not null check (source in ('session', 'webhook', 'reconcile', 'system')),
  status            text not null,
  amount_minor      bigint,
  currency          char(3),
  provider_event_id text,
  occurred_at       timestamptz,
  raw_sha256        text check (raw_sha256 ~ '^[0-9a-f]{64}$'),
  outcome           text not null,
  created_at        timestamptz not null default now()
);

create index payment_events_payment_idx on public.payment_events (payment_id, created_at);

create table public.webhook_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 200),
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  outcome           text,
  constraint webhook_events_provider_event_key unique (provider, provider_event_id)
);

create trigger payment_events_append_only before update or delete on public.payment_events
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------------
-- Refunds (records; processing in Stage I)
-- ---------------------------------------------------------------------------
create table public.refunds (
  id                        uuid primary key default gen_random_uuid(),
  community_id              uuid not null references public.communities (id) on delete restrict,
  payment_id                uuid not null references public.payments (id) on delete restrict,
  order_id                  uuid references public.orders (id) on delete restrict,
  booking_id                uuid,
  buyer_user_id             uuid references public.profiles (id) on delete set null,
  seller_user_id            uuid references public.profiles (id) on delete set null,
  kind                      text not null check (kind in ('customer', 'automatic')),
  requested_by              uuid references public.profiles (id) on delete set null,
  reason                    text not null check (char_length(btrim(reason)) between 1 and 500),
  amount_minor              bigint not null check (amount_minor > 0),
  currency                  char(3) not null,
  status                    text not null default 'requested'
                            check (status in ('requested', 'approved', 'rejected', 'processing', 'pending', 'succeeded', 'failed')),
  decision_note             text check (char_length(decision_note) <= 500),
  decided_by                uuid references public.profiles (id) on delete set null,
  provider_refund_reference text,
  failure_code              text check (char_length(failure_code) <= 80),
  attempts                  integer not null default 0,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  succeeded_at              timestamptz
);

create index refunds_payment_idx on public.refunds (payment_id);
create index refunds_order_idx on public.refunds (order_id);
create index refunds_work_idx on public.refunds (updated_at) where status in ('approved', 'processing', 'pending', 'failed');

create table public.refund_items (
  refund_id     uuid not null references public.refunds (id) on delete restrict,
  order_item_id uuid not null references public.order_items (id) on delete restrict,
  quantity      integer not null check (quantity between 1 and 99),
  amount_minor  bigint not null check (amount_minor > 0),
  primary key (refund_id, order_item_id)
);

create table public.refund_events (
  id            uuid primary key default gen_random_uuid(),
  refund_id     uuid not null references public.refunds (id) on delete restrict,
  from_status   text,
  to_status     text not null,
  actor_user_id uuid references public.profiles (id) on delete set null,
  note          text,
  created_at    timestamptz not null default now()
);

create trigger refunds_set_updated_at before update on public.refunds
  for each row execute function private.set_updated_at();
create trigger refund_events_append_only before update or delete on public.refund_events
  for each row execute function private.forbid_change();
create trigger refund_items_append_only before update or delete on public.refund_items
  for each row execute function private.forbid_change();

-- Records a refund status change.
create or replace function private.refund_transition(p_refund_id uuid, p_to text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from text;
begin
  select status into v_from from public.refunds where id = p_refund_id for update;
  if v_from is distinct from p_to then
    update public.refunds set status = p_to where id = p_refund_id;
    insert into public.refund_events (refund_id, from_status, to_status, actor_user_id, note)
    values (p_refund_id, v_from, p_to, private.actor_user_id(), p_note);
  end if;
end;
$$;

revoke all on function private.refund_transition(uuid, text, text) from public, anon, authenticated, service_role;

-- Creates a refund record, never more than what was paid and not yet
-- refunded (or being refunded) on that payment. Locks the payment.
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
  v_order   public.orders;
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
    select * into v_order from public.orders where id = p_order_id;
  end if;
  insert into public.refunds (community_id, payment_id, order_id, booking_id, buyer_user_id, seller_user_id, kind, requested_by,
                              reason, amount_minor, currency, status)
  values (v_payment.community_id, p_payment_id, p_order_id, v_payment.booking_id, v_payment.payer_user_id, v_order.seller_user_id,
          p_kind, p_requested_by, p_reason, p_amount_minor, v_payment.currency, p_status)
  returning id into v_id;
  insert into public.refund_events (refund_id, from_status, to_status, actor_user_id, note)
  values (v_id, null, p_status, private.actor_user_id(), p_reason);
  return v_id;
end;
$$;

revoke all on function private.create_refund(uuid, uuid, bigint, text, text, text, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Ledger (double-entry, append-only)
-- ---------------------------------------------------------------------------
create table public.ledger_accounts (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('platform_clearing', 'seller_payable', 'platform_revenue', 'payouts_sent')),
  -- Pseudonymous on purpose (no foreign key): financial records outlive an
  -- account deletion, like audit_logs; the id no longer resolves to anyone.
  owner_user_id uuid,
  community_id  uuid references public.communities (id) on delete restrict,
  currency      char(3) not null default 'JMD',
  created_at    timestamptz not null default now(),
  constraint ledger_accounts_key unique nulls not distinct (kind, owner_user_id, community_id, currency),
  constraint ledger_accounts_owner check ((kind = 'seller_payable') = (owner_user_id is not null))
);

create table public.ledger_transactions (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('payment_captured', 'refund', 'payout', 'adjustment')),
  reference_type text not null,
  reference_id   uuid not null,
  community_id   uuid references public.communities (id) on delete restrict,
  created_at     timestamptz not null default now(),
  constraint ledger_transactions_once unique (kind, reference_type, reference_id)
);

create table public.ledger_entries (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.ledger_transactions (id) on delete restrict,
  account_id     uuid not null references public.ledger_accounts (id) on delete restrict,
  amount_minor   bigint not null check (amount_minor <> 0),
  created_at     timestamptz not null default now()
);

create index ledger_entries_account_idx on public.ledger_entries (account_id, created_at);
create index ledger_entries_transaction_idx on public.ledger_entries (transaction_id);

create trigger ledger_entries_append_only before update or delete on public.ledger_entries
  for each row execute function private.forbid_change();
create trigger ledger_transactions_append_only before update or delete on public.ledger_transactions
  for each row execute function private.forbid_change();

-- Every transaction balances (checked at commit).
create or replace function private.check_ledger_balanced()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select coalesce(sum(amount_minor), 0) from public.ledger_entries where transaction_id = new.transaction_id) <> 0 then
    raise exception 'ledger transaction % does not balance', new.transaction_id using errcode = '23514';
  end if;
  return null;
end;
$$;

revoke all on function private.check_ledger_balanced() from public, anon, authenticated;

create constraint trigger ledger_entries_balanced
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function private.check_ledger_balanced();

create or replace function private.ledger_account(p_kind text, p_owner uuid, p_community_id uuid, p_currency text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.ledger_accounts
  where kind = p_kind and owner_user_id is not distinct from p_owner
    and community_id is not distinct from p_community_id and currency = p_currency;
  if v_id is null then
    insert into public.ledger_accounts (kind, owner_user_id, community_id, currency)
    values (p_kind, p_owner, p_community_id, p_currency)
    on conflict on constraint ledger_accounts_key do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.ledger_accounts
      where kind = p_kind and owner_user_id is not distinct from p_owner
        and community_id is not distinct from p_community_id and currency = p_currency;
    end if;
  end if;
  return v_id;
end;
$$;

-- Posts a balanced transaction once per (kind, reference). Entries:
-- [{ "account": "platform_clearing", "owner": null, "amount_minor": 123 }, ...]
create or replace function private.post_ledger(
  p_kind text, p_reference_type text, p_reference_id uuid, p_community_id uuid, p_currency text, p_entries jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx uuid;
  e    jsonb;
begin
  if (select coalesce(sum((x->>'amount_minor')::bigint), 0) from jsonb_array_elements(p_entries) x) <> 0 then
    raise exception 'ledger entries must balance' using errcode = '23514';
  end if;
  insert into public.ledger_transactions (kind, reference_type, reference_id, community_id)
  values (p_kind, p_reference_type, p_reference_id, p_community_id)
  on conflict on constraint ledger_transactions_once do nothing
  returning id into v_tx;
  if v_tx is null then
    return null; -- already posted
  end if;
  for e in select * from jsonb_array_elements(p_entries) loop
    if (e->>'amount_minor')::bigint <> 0 then
      insert into public.ledger_entries (transaction_id, account_id, amount_minor)
      values (v_tx, private.ledger_account(e->>'account', nullif(e->>'owner', '')::uuid, p_community_id, p_currency),
              (e->>'amount_minor')::bigint);
    end if;
  end loop;
  return v_tx;
end;
$$;

revoke all on function private.ledger_account(text, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.post_ledger(text, text, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Settling a paid checkout
-- ---------------------------------------------------------------------------
-- Commits the stock, marks the orders paid, posts the ledger and notifies.
-- If the reservation had already been released (payment arrived after
-- expiry/cancel), stock is re-reserved when available; otherwise the orders
-- are cancelled and a full automatic refund is created.
create or replace function private.settle_paid_checkout(p_checkout_id uuid, p_payment_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkout public.checkouts;
  v_line     record;
  v_order    record;
  v_short    boolean := false;
  v_entries  jsonb := '[]'::jsonb;
begin
  select * into v_checkout from public.checkouts where id = p_checkout_id for update;

  -- Lock the stock rows in a fixed order.
  perform 1 from public.inventory i
  where i.listing_id in (select listing_id from public.inventory_reservations where checkout_id = p_checkout_id)
  order by i.listing_id for update;

  -- Released reservations (late payment): can everything still be supplied?
  for v_line in
    select ir.id, ir.listing_id, ir.quantity, ir.status, i.on_hand, i.reserved
    from public.inventory_reservations ir join public.inventory i on i.listing_id = ir.listing_id
    where ir.checkout_id = p_checkout_id
  loop
    if v_line.status = 'released' and v_line.on_hand - v_line.reserved < v_line.quantity then
      v_short := true;
    end if;
  end loop;

  update public.checkouts set status = 'paid', paid_at = now() where id = p_checkout_id;

  -- The money arrived either way: platform clearing up, each seller owed their order.
  for v_order in select id, seller_user_id, total_minor from public.orders where checkout_id = p_checkout_id loop
    v_entries := v_entries || jsonb_build_object('account', 'seller_payable', 'owner', v_order.seller_user_id,
                                                 'amount_minor', -v_order.total_minor);
  end loop;
  v_entries := v_entries || jsonb_build_object('account', 'platform_clearing', 'owner', null, 'amount_minor', v_checkout.total_minor);
  perform private.post_ledger('payment_captured', 'payment', p_payment_id, v_checkout.community_id, v_checkout.currency, v_entries);

  if v_short then
    for v_order in select id from public.orders where checkout_id = p_checkout_id loop
      perform private.order_transition(v_order.id, 'cancelled', 'Out of stock when the late payment arrived');
      perform private.create_refund(p_payment_id, v_order.id, (select total_minor from public.orders where id = v_order.id),
        'Automatic refund: the items were no longer available when your payment was confirmed', 'automatic');
    end loop;
    perform private.create_notification(v_checkout.buyer_user_id, v_checkout.community_id, 'payment',
      'Payment received, but the items sold out',
      'Your payment arrived after your reservation ended and the items are no longer available. A full refund has been started.',
      jsonb_build_object('checkout_id', p_checkout_id), 'payment:' || p_payment_id || ':late');
    return 'refunding';
  end if;

  for v_line in
    select ir.id, ir.listing_id, ir.quantity, ir.status from public.inventory_reservations ir where ir.checkout_id = p_checkout_id
  loop
    update public.inventory
    set on_hand = on_hand - v_line.quantity,
        reserved = reserved - case when v_line.status = 'held' then v_line.quantity else 0 end,
        updated_at = now()
    where listing_id = v_line.listing_id;
    update public.inventory_reservations set status = 'committed' where id = v_line.id;
    insert into public.inventory_movements (listing_id, community_id, delta, on_hand_after, reason, note)
    select v_line.listing_id, v_checkout.community_id, -v_line.quantity, i.on_hand, 'sale', 'checkout ' || p_checkout_id
    from public.inventory i where i.listing_id = v_line.listing_id;
  end loop;

  for v_order in select id, seller_user_id from public.orders where checkout_id = p_checkout_id loop
    perform private.order_transition(v_order.id, 'paid', 'Payment confirmed');
    if v_order.seller_user_id is not null then
      perform private.create_notification(v_order.seller_user_id, v_checkout.community_id, 'order',
        'New order to accept', 'A buyer paid for your items. Accept or reject the order.',
        jsonb_build_object('order_id', v_order.id), 'order:' || v_order.id || ':paid');
    end if;
  end loop;
  if v_checkout.buyer_user_id is not null then
    perform private.create_notification(v_checkout.buyer_user_id, v_checkout.community_id, 'payment',
      'Payment confirmed', 'Your order has been sent to the seller.',
      jsonb_build_object('checkout_id', p_checkout_id), 'payment:' || p_payment_id || ':succeeded');
  end if;
  return 'paid';
end;
$$;

revoke all on function private.settle_paid_checkout(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Payment API for the payments Edge Functions (service role only)
-- ---------------------------------------------------------------------------
-- Starts (or reuses) a payment attempt for a buyer's checkout. The amount is
-- the checkout total; the user id comes from the Edge Function's verified JWT.
create or replace function public.payment_begin(p_user_id uuid, p_checkout_id uuid, p_provider text, p_mode text)
returns table (payment_id uuid, amount_minor bigint, currency text, provider_reference text, redirect_url text,
               session_expires_at timestamptz, description text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_checkout public.checkouts;
  v_payment  public.payments;
begin
  select * into v_checkout from public.checkouts c where c.id = p_checkout_id for update;
  if v_checkout.id is null or v_checkout.buyer_user_id is distinct from p_user_id then
    raise exception 'checkout not found' using errcode = 'P0002';
  end if;
  if v_checkout.status not in ('awaiting_payment', 'payment_failed') then
    raise exception 'this order cannot be paid (%)', v_checkout.status using errcode = '22023';
  end if;
  if v_checkout.reservation_expires_at <= now() then
    raise exception 'the reservation for this order has ended; place the order again' using errcode = '22023';
  end if;
  if not exists (select 1 from public.memberships m where m.community_id = v_checkout.community_id
                 and m.user_id = p_user_id and m.status = 'active') then
    raise exception 'checkout not found' using errcode = 'P0002';
  end if;

  -- Reuse an open attempt whose session is still valid.
  select * into v_payment from public.payments p
  where p.checkout_id = p_checkout_id and p.status in ('pending', 'requires_action') and p.provider = p_provider
    and p.provider_reference is not null and (p.session_expires_at is null or p.session_expires_at > now() + interval '1 minute')
  order by p.created_at desc limit 1;
  if v_payment.id is null then
    insert into public.payments (community_id, checkout_id, payer_user_id, provider, mode, amount_minor, currency)
    values (v_checkout.community_id, p_checkout_id, p_user_id, p_provider, p_mode, v_checkout.total_minor, v_checkout.currency)
    returning * into v_payment;
    insert into public.payment_events (payment_id, source, status, amount_minor, currency, outcome)
    values (v_payment.id, 'session', 'pending', v_payment.amount_minor, v_payment.currency, 'created');
    update public.checkouts set status = 'awaiting_payment' where id = p_checkout_id and status = 'payment_failed';
  end if;
  return query select v_payment.id, v_payment.amount_minor, v_payment.currency::text, v_payment.provider_reference,
                      v_payment.redirect_url, v_payment.session_expires_at,
                      'CommuniOne order ' || left(p_checkout_id::text, 8);
end;
$$;

create or replace function public.payment_attach_session(
  p_payment_id uuid, p_provider_reference text, p_redirect_url text, p_session_expires_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.payments
  set provider_reference = p_provider_reference, redirect_url = p_redirect_url, session_expires_at = p_session_expires_at
  where id = p_payment_id and status = 'pending' and (provider_reference is null or provider_reference = p_provider_reference);
  if not found then
    raise exception 'payment not found or no longer pending' using errcode = 'P0002';
  end if;
end;
$$;

-- Applies a VERIFIED provider event (webhook or reconciliation). Returns:
--   applied | duplicate | ignored | mismatch | unknown_payment
create or replace function public.payment_apply_event(
  p_provider text, p_provider_event_id text, p_provider_reference text, p_status text,
  p_amount_minor bigint, p_currency text, p_occurred_at timestamptz, p_raw_sha256 text, p_source text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_outcome text;
  v_checkout public.checkouts;
begin
  if p_status not in ('pending', 'requires_action', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown') then
    raise exception 'unknown payment status %', p_status using errcode = '22023';
  end if;
  if p_source not in ('webhook', 'reconcile') then
    raise exception 'unknown event source' using errcode = '22023';
  end if;

  -- Each provider event is processed once.
  if p_provider_event_id is not null then
    insert into public.webhook_events (provider, provider_event_id) values (p_provider, p_provider_event_id)
    on conflict on constraint webhook_events_provider_event_key do nothing;
    if not found then
      return 'duplicate';
    end if;
  end if;

  select * into v_payment from public.payments where provider = p_provider and provider_reference = p_provider_reference for update;
  if v_payment.id is null then
    update public.webhook_events set processed_at = now(), outcome = 'unknown_payment'
    where provider = p_provider and provider_event_id = p_provider_event_id;
    return 'unknown_payment';
  end if;

  if p_status = 'succeeded' and (p_amount_minor is distinct from v_payment.amount_minor or p_currency is distinct from v_payment.currency::text) then
    update public.payments set status = 'unknown', failure_code = 'amount_mismatch' where id = v_payment.id;
    v_outcome := 'mismatch';
    perform private.record_audit_event(v_payment.community_id, 'payment.mismatch', 'payment', v_payment.id,
      jsonb_build_object('expected', v_payment.amount_minor, 'reported', p_amount_minor, 'currency', p_currency));
  elsif v_payment.status = 'succeeded' or p_status = v_payment.status
        or (v_payment.failure_code = 'amount_mismatch') then
    -- Final, unchanged, or under manual review.
    v_outcome := 'ignored';
  elsif p_status = 'succeeded' then
    if v_payment.checkout_id is not null then
      select * into v_checkout from public.checkouts where id = v_payment.checkout_id for update;
    end if;
    -- A second capture for an already-paid checkout is flagged in the same
    -- statement (the one-success-per-checkout index ignores flagged rows).
    update public.payments
    set status = 'succeeded', confirmed_at = coalesce(p_occurred_at, now()),
        failure_code = case when v_checkout.status in ('paid', 'partially_refunded', 'refunded') then 'duplicate_payment' end
    where id = v_payment.id;
    perform private.record_audit_event(v_payment.community_id, 'payment.succeeded', 'payment', v_payment.id,
      jsonb_build_object('amount_minor', v_payment.amount_minor));
    if v_payment.checkout_id is not null then
      if v_checkout.status in ('paid', 'partially_refunded', 'refunded') then
        -- Paid twice: this second payment is refunded in full.
        perform private.post_ledger('payment_captured', 'payment', v_payment.id, v_payment.community_id, v_payment.currency,
          jsonb_build_array(jsonb_build_object('account', 'platform_clearing', 'owner', null, 'amount_minor', v_payment.amount_minor),
                            jsonb_build_object('account', 'platform_revenue', 'owner', null, 'amount_minor', -v_payment.amount_minor)));
        perform private.create_refund(v_payment.id, null, v_payment.amount_minor, 'Automatic refund: this order was already paid', 'automatic');
        v_outcome := 'applied';
      else
        perform private.settle_paid_checkout(v_payment.checkout_id, v_payment.id);
        v_outcome := 'applied';
      end if;
    else
      v_outcome := 'applied'; -- bookings: settled by the Stage J function
      perform private.settle_paid_booking(v_payment.booking_id, v_payment.id);
    end if;
  elsif p_status in ('failed', 'cancelled', 'expired') then
    update public.payments set status = p_status, failure_code = coalesce(failure_code, p_status) where id = v_payment.id;
    perform private.record_audit_event(v_payment.community_id, 'payment.failed', 'payment', v_payment.id,
      jsonb_build_object('status', p_status));
    if v_payment.checkout_id is not null then
      update public.checkouts set status = 'payment_failed'
      where id = v_payment.checkout_id and status = 'awaiting_payment'
        and not exists (select 1 from public.payments p where p.checkout_id = v_payment.checkout_id and p.id <> v_payment.id
                        and p.status in ('pending', 'requires_action', 'unknown'));
    end if;
    if v_payment.payer_user_id is not null then
      perform private.create_notification(v_payment.payer_user_id, v_payment.community_id, 'payment',
        'Payment not completed', 'Your payment did not go through. You can try again while your items are reserved.',
        jsonb_build_object('checkout_id', v_payment.checkout_id, 'booking_id', v_payment.booking_id),
        'payment:' || v_payment.id || ':' || p_status);
    end if;
    v_outcome := 'applied';
  else
    -- pending / requires_action / unknown: progress only.
    update public.payments set status = p_status where id = v_payment.id;
    v_outcome := 'applied';
  end if;

  insert into public.payment_events (payment_id, source, status, amount_minor, currency, provider_event_id, occurred_at, raw_sha256, outcome)
  values (v_payment.id, p_source, p_status, p_amount_minor, p_currency, p_provider_event_id, p_occurred_at, p_raw_sha256, v_outcome);
  if p_provider_event_id is not null then
    update public.webhook_events set processed_at = now(), outcome = v_outcome
    where provider = p_provider and provider_event_id = p_provider_event_id;
  end if;
  return v_outcome;
end;
$$;

-- Bookings are settled in Stage J; until then this is never reached.
create or replace function private.settle_paid_booking(p_booking_id uuid, p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'booking payments are not available yet (booking %, payment %)', p_booking_id, p_payment_id using errcode = '0A000';
end;
$$;

revoke all on function private.settle_paid_booking(uuid, uuid) from public, anon, authenticated, service_role;

-- Open payments for the reconciler: pending/unknown for longer than p_age.
create or replace function public.payments_to_reconcile(p_age interval default interval '5 minutes')
returns table (payment_id uuid, provider text, provider_reference text, status text, amount_minor bigint, currency text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.provider, p.provider_reference, p.status, p.amount_minor, p.currency::text
  from public.payments p
  where p.status in ('pending', 'requires_action', 'unknown') and p.provider_reference is not null
    and coalesce(p.failure_code, '') <> 'amount_mismatch'
    and p.updated_at < now() - p_age
  order by p.updated_at
  limit 200;
$$;

revoke all on function public.payment_begin(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.payment_attach_session(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.payment_apply_event(text, text, text, text, bigint, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.payments_to_reconcile(interval) from public, anon, authenticated;
grant execute on function public.payment_begin(uuid, uuid, text, text) to service_role;
grant execute on function public.payment_attach_session(uuid, text, text, timestamptz) to service_role;
grant execute on function public.payment_apply_event(text, text, text, text, bigint, text, timestamptz, text, text) to service_role;
grant execute on function public.payments_to_reconcile(interval) to service_role;

insert into public.audit_actions (action, entity_type, description) values
  ('payment.succeeded', 'payment', 'A payment was confirmed by the provider'),
  ('payment.failed',    'payment', 'A payment failed, was cancelled or expired'),
  ('payment.mismatch',  'payment', 'A provider reported a different amount or currency; held for review')
on conflict (action) do nothing;

-- ---------------------------------------------------------------------------
-- Privileges and RLS: buyers read their own payments and refunds (no
-- provider payloads); sellers read refunds of their orders. Ledger tables
-- are server-only (sellers get balances through Stage K functions).
-- ---------------------------------------------------------------------------
revoke all on table public.payments, public.payment_events, public.webhook_events, public.refunds, public.refund_items,
  public.refund_events, public.ledger_accounts, public.ledger_transactions, public.ledger_entries from public, anon, authenticated;
grant all on table public.payments, public.payment_events, public.webhook_events, public.refunds, public.refund_items,
  public.refund_events, public.ledger_accounts, public.ledger_transactions, public.ledger_entries to service_role;
alter table public.payments            enable row level security;
alter table public.payment_events      enable row level security;
alter table public.webhook_events      enable row level security;
alter table public.refunds             enable row level security;
alter table public.refund_items        enable row level security;
alter table public.refund_events       enable row level security;
alter table public.ledger_accounts     enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries      enable row level security;

grant select (id, community_id, checkout_id, booking_id, provider, mode, amount_minor, currency, status, failure_code,
              created_at, updated_at, confirmed_at) on public.payments to authenticated;
create policy payments_select_payer on public.payments
  for select to authenticated using (payer_user_id = (select private.current_active_user_id()));

grant select on public.refunds, public.refund_items, public.refund_events to authenticated;
create policy refunds_select_parties on public.refunds
  for select to authenticated
  using (buyer_user_id = (select private.current_active_user_id()) or seller_user_id = (select private.current_active_user_id()));
create policy refund_items_select_parties on public.refund_items
  for select to authenticated
  using (exists (select 1 from public.refunds r where r.id = refund_id
                 and (r.buyer_user_id = (select private.current_active_user_id()) or r.seller_user_id = (select private.current_active_user_id()))));
create policy refund_events_select_parties on public.refund_events
  for select to authenticated
  using (exists (select 1 from public.refunds r where r.id = refund_id
                 and (r.buyer_user_id = (select private.current_active_user_id()) or r.seller_user_id = (select private.current_active_user_id()))));

-- ---------------------------------------------------------------------------
-- The TEST payment provider's own state (Stage E). Used only with
-- PAYMENTS_MODE=test (the Edge Functions refuse it otherwise). It stands in
-- for the provider's side so the whole flow can be exercised without money.
-- Service role only.
-- ---------------------------------------------------------------------------
create table public.test_provider_sessions (
  reference      text primary key check (reference ~ '^tp_[0-9a-f]{32}$'),
  payment_id     uuid not null unique,
  amount_minor   bigint not null check (amount_minor > 0),
  currency       char(3) not null,
  status         text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'cancelled', 'expired')),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  return_url     text not null,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

revoke all on table public.test_provider_sessions from public, anon, authenticated;
grant all on table public.test_provider_sessions to service_role;
alter table public.test_provider_sessions enable row level security;
