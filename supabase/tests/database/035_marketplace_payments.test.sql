-- Marketplace Stages E-F (migration 35): server-only payment API, state machine, duplicate and replayed events, amount mismatch, atomic settlement, balanced append-only ledger, duplicate-payment refund, privacy.
begin;
create extension if not exists pgtap with schema extensions;

select plan(42);

-- ---------------------------------------------------------------------------
-- Fixture (identical in every behavioural test file)
--
--   Community A (community-a)            Community B (community-b)
--     alice  Owner  (creator)              bob    Owner  (creator)
--     erin   Admin                         frank  Member
--     dave   Moderator                     alice  Member  <- multi-community
--     carol  Member
--     grace  pending, no role
--
-- Communities are created through public.create_community() as the real
-- users. Other memberships are inserted as a trusted backend would (the
-- Stage 2 invitation / join flows), because clients cannot insert them.
-- ---------------------------------------------------------------------------
-- Impersonates a signed-in user exactly as PostgREST does: role
-- `authenticated` plus verified JWT claims. Every fixture user has a live
-- auth.sessions row whose id equals the user id (see below).
create function pg_temp.login(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated', 'session_id', p_user, 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create temp table fx (key text primary key, id uuid not null);
grant all on fx to public;

create function pg_temp.fx(p_key text) returns uuid language sql stable as $$
  select id from fx where key = p_key
$$;

create function pg_temp.role_id(p_community text, p_role text) returns uuid language sql stable as $$
  select r.id from public.roles r where r.community_id = pg_temp.fx(p_community) and r.name = p_role
$$;

create function pg_temp.add_member(p_community text, p_user text, p_role text, p_status text default 'active')
returns void language plpgsql as $$
declare v_membership_id uuid;
begin
  insert into public.memberships (community_id, user_id, status)
  values (pg_temp.fx(p_community), pg_temp.fx(p_user), p_status)
  returning id into v_membership_id;
  insert into fx values (p_user || '@' || p_community, v_membership_id);
  if p_role is not null then
    insert into public.membership_roles (membership_id, role_id)
    values (v_membership_id, pg_temp.role_id(p_community, p_role));
  end if;
end;
$$;

insert into fx values
  ('alice', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('bob',   'bbbbbbbb-0000-4000-8000-000000000002'),
  ('carol', 'cccccccc-0000-4000-8000-000000000003'),
  ('dave',  'dddddddd-0000-4000-8000-000000000004'),
  ('erin',  'eeeeeeee-0000-4000-8000-000000000005'),
  ('frank', 'ffffffff-0000-4000-8000-000000000006'),
  ('grace', '99999999-0000-4000-8000-000000000007');

insert into auth.users (id, email)
select id, key || '@example.test' from fx;
insert into auth.sessions (id, user_id)
select id, id from fx;

select pg_temp.login(pg_temp.fx('alice'));
insert into fx select 'A', id from public.create_community('Community A', 'community-a', 'residential');
select pg_temp.login(pg_temp.fx('bob'));
insert into fx select 'B', id from public.create_community('Community B', 'community-b', 'church');
reset role;

insert into fx select 'alice@A', id from public.memberships where community_id = pg_temp.fx('A') and user_id = pg_temp.fx('alice');
insert into fx select 'bob@B',   id from public.memberships where community_id = pg_temp.fx('B') and user_id = pg_temp.fx('bob');

select pg_temp.add_member('A', 'erin',  'Admin');
select pg_temp.add_member('A', 'dave',  'Moderator');
select pg_temp.add_member('A', 'carol', 'Member');
select pg_temp.add_member('A', 'grace', null, 'pending');
select pg_temp.add_member('B', 'frank', 'Member');
select pg_temp.add_member('B', 'alice', 'Member');
-- ---------------------------------------------------------------------------


-- Catalog fixture (trusted setup): carol (GCT-registered, delivers to Kingston) and erin sell in A.
insert into public.seller_profiles (id, community_id, user_id, display_name, gct_registered) values
  ('5e000000-0000-4000-8000-000000000001', pg_temp.fx('A'), pg_temp.fx('carol'), 'Carol Shop', true),
  ('5e000000-0000-4000-8000-000000000002', pg_temp.fx('A'), pg_temp.fx('erin'),  'Erin Books', false);
insert into public.delivery_options (seller_profile_id, community_id, fee_minor, parishes, estimated_days_min, estimated_days_max)
  values ('5e000000-0000-4000-8000-000000000001', pg_temp.fx('A'), 50000, '{Kingston}', 1, 2);
insert into public.listings (id, community_id, seller_profile_id, seller_user_id, kind, category_id, title, condition, price_minor, fulfillment, status) values
  ('1a000000-0000-4000-8000-000000000001', pg_temp.fx('A'), '5e000000-0000-4000-8000-000000000001', pg_temp.fx('carol'), 'product',
   (select id from public.market_categories where slug = 'electronics'), 'Radio', 'good', 500000, '{pickup,seller_delivery}', 'active'),
  ('1a000000-0000-4000-8000-000000000002', pg_temp.fx('A'), '5e000000-0000-4000-8000-000000000001', pg_temp.fx('carol'), 'product',
   (select id from public.market_categories where slug = 'electronics'), 'Lamp', 'new', 250000, '{pickup,seller_delivery}', 'active'),
  ('1a000000-0000-4000-8000-000000000003', pg_temp.fx('A'), '5e000000-0000-4000-8000-000000000002', pg_temp.fx('erin'), 'product',
   (select id from public.market_categories where slug = 'books-media'), 'Book', 'good', 100000, '{pickup}', 'active');
update public.inventory set on_hand = 3 where listing_id = '1a000000-0000-4000-8000-000000000001';
update public.inventory set on_hand = 1 where listing_id = '1a000000-0000-4000-8000-000000000002';
update public.inventory set on_hand = 5 where listing_id = '1a000000-0000-4000-8000-000000000003';

create function pg_temp.choices(p_carol text, p_erin text) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('seller_profile_id', '5e000000-0000-4000-8000-000000000001', 'method', p_carol),
    jsonb_build_object('seller_profile_id', '5e000000-0000-4000-8000-000000000002', 'method', p_erin))
$$;
create function pg_temp.reserved(p_listing text) returns int language sql security definer as $$
  select reserved from public.inventory where listing_id = p_listing::uuid
$$;

-- dave buys 2 Radios (carol, GCT) and 1 Book (erin), pickup.
select pg_temp.login(pg_temp.fx('dave'));
select public.cart_set_item('1a000000-0000-4000-8000-000000000001', 2);
select public.cart_set_item('1a000000-0000-4000-8000-000000000003', 1);
select public.checkout_create(pg_temp.fx('A'), '00000000-0000-4000-8000-0000000000d1', pg_temp.choices('pickup', 'pickup'),
  null, 'Dave D', '876 555 0101', 1250000, 'v1');
reset role;
create function pg_temp.ck() returns uuid language sql as $$ select id from public.checkouts where client_request_id = '00000000-0000-4000-8000-0000000000d1' $$;
create function pg_temp.pay(p_ref text) returns uuid language sql as $$ select id from public.payments where provider_reference = p_ref $$;
create function pg_temp.apply(p_event text, p_ref text, p_status text, p_amount bigint) returns text language sql as $$
  select public.payment_apply_event('test', p_event, p_ref, p_status, p_amount, 'JMD', now(), repeat('a', 64), 'webhook')
$$;
create function pg_temp.ledger_sum() returns bigint language sql as $$ select coalesce(sum(e.amount_minor), 0)::bigint from public.ledger_entries e
  join public.ledger_transactions t on t.id = e.transaction_id where t.community_id = pg_temp.fx('A') $$;

-- =========================================================================
-- 1. Only the server starts payments, for the amount in the database
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(format($$ select * from public.payment_begin(%L, %L, 'test', 'test') $$, pg_temp.fx('dave'), pg_temp.ck()),
  '42501', null, '1. clients cannot start a payment directly');
select throws_ok($$ select public.payment_apply_event('test', 'e', 'r', 'succeeded', 1, 'JMD', now(), null, 'webhook') $$,
  '42501', null, '1. nor report a payment status');
select throws_ok($$ insert into public.payments (community_id, provider, mode, amount_minor, currency) values (pg_temp.fx('A'), 'test', 'test', 1, 'JMD') $$,
  '42501', null, '1. nor insert payments');
set local role service_role;
select throws_ok(format($$ select * from public.payment_begin(%L, %L, 'test', 'test') $$, pg_temp.fx('carol'), pg_temp.ck()),
  'P0002', 'checkout not found', '1. a payment is only for the buyer''s own checkout');
select is((select amount_minor from public.payment_begin(pg_temp.fx('dave'), pg_temp.ck(), 'test', 'test')), 1250000::bigint,
  '1. the amount is the checkout total');
select lives_ok($$ select public.payment_attach_session((select id from public.payments where checkout_id = pg_temp.ck()), 'ref_1', 'https://pay.example/1', now() + interval '15 minutes') $$,
  '1. the provider session is attached');
select is((select payment_id from public.payment_begin(pg_temp.fx('dave'), pg_temp.ck(), 'test', 'test')), pg_temp.pay('ref_1'),
  '1. an open session is reused');

-- =========================================================================
-- 2. Failed, then paid: settlement is atomic and the ledger balances
-- =========================================================================
select is(pg_temp.apply('ev_1', 'ref_1', 'failed', null), 'applied', '2. a decline is applied');
select is((select status from public.checkouts where id = pg_temp.ck()), 'payment_failed', '2. checkout payment_failed');
select is((select reserved from public.inventory where listing_id = '1a000000-0000-4000-8000-000000000001'), 2, '2. stock still reserved');
select isnt((select payment_id from public.payment_begin(pg_temp.fx('dave'), pg_temp.ck(), 'test', 'test')), pg_temp.pay('ref_1'),
  '2. a retry is a new attempt');
select public.payment_attach_session((select id from public.payments where checkout_id = pg_temp.ck() and provider_reference is null), 'ref_2', 'https://pay.example/2', now() + interval '15 minutes');
select is(pg_temp.apply('ev_2', 'ref_2', 'succeeded', 1250000), 'applied', '2. success applied');
select is(pg_temp.apply('ev_2', 'ref_2', 'succeeded', 1250000), 'duplicate', '2. the same event again is a duplicate');
select is(pg_temp.apply('ev_3', 'ref_2', 'succeeded', 1250000), 'ignored', '2. a second success event for the same payment changes nothing');
select is(pg_temp.apply('ev_4', 'ref_2', 'failed', null), 'ignored', '2. a late failure cannot undo a success');
select is((select status from public.checkouts where id = pg_temp.ck()), 'paid', '2. checkout paid');
select results_eq($$ select status from public.orders where checkout_id = pg_temp.ck() order by total_minor $$, $$ values ('paid'::text), ('paid') $$, '2. both seller orders paid');
select results_eq($$ select on_hand, reserved from public.inventory where listing_id = '1a000000-0000-4000-8000-000000000001' $$,
  $$ values (1, 0) $$, '2. stock committed');
select is((select count(*)::int from public.inventory_movements m join public.listings l on l.id = m.listing_id where m.reason = 'sale' and l.community_id = pg_temp.fx('A')), 2, '2. sale movements recorded');
select is(pg_temp.ledger_sum(), 0::bigint, '2. the ledger balances');
select results_eq($$ select a.kind, a.owner_user_id, sum(e.amount_minor)::bigint from public.ledger_entries e join public.ledger_accounts a on a.id = e.account_id
                     where a.community_id = pg_temp.fx('A')
                     group by 1, 2 order by 1, 3 $$,
  format($$ values ('platform_clearing'::text, null::uuid, 1250000::bigint), ('seller_payable', %L::uuid, -1150000::bigint), ('seller_payable', %L::uuid, -100000::bigint) $$,
    pg_temp.fx('carol'), pg_temp.fx('erin')),
  '2. clearing holds the payment; each seller is owed their order total (no commission: D4)');
select is((select count(*)::int from public.notifications where type = 'order' and user_id in (pg_temp.fx('carol'), pg_temp.fx('erin'))), 2,
  '2. each seller is told to accept the order');
select is((select count(*)::int from public.audit_logs where action = 'payment.succeeded' and community_id = pg_temp.fx('A')), 1, '2. audited');
reset role;
select throws_ok($$ delete from public.ledger_entries $$, '42501', null, '2. the ledger is append-only');
select throws_ok($$ update public.payment_events set status = 'failed' $$, '42501', null, '2. payment events are append-only');
select throws_ok($$ insert into public.ledger_transactions (kind, reference_type, reference_id, community_id) values ('adjustment', 'x', gen_random_uuid(), null);
                    insert into public.ledger_entries (transaction_id, account_id, amount_minor)
                      values ((select id from public.ledger_transactions where reference_type = 'x'), (select id from public.ledger_accounts limit 1), 5);
                    set constraints all immediate $$,
  '23514', null, '2. an unbalanced transaction is refused');

-- =========================================================================
-- 3. A second successful payment for a paid checkout is refunded
-- =========================================================================
set local role service_role;
insert into public.payments (community_id, checkout_id, payer_user_id, provider, mode, amount_minor, currency, provider_reference)
  values (pg_temp.fx('A'), pg_temp.ck(), pg_temp.fx('dave'), 'test', 'test', 1250000, 'JMD', 'ref_3');
select is(pg_temp.apply('ev_5', 'ref_3', 'succeeded', 1250000), 'applied', '3. the duplicate payment is accepted from the provider');
select is((select failure_code from public.payments where provider_reference = 'ref_3'), 'duplicate_payment', '3. flagged as a duplicate');
select results_eq($$ select kind, status, amount_minor from public.refunds where payment_id = pg_temp.pay('ref_3') $$,
  $$ values ('automatic'::text, 'approved'::text, 1250000::bigint) $$, '3. and refunded in full (to be processed)');
select is(pg_temp.ledger_sum(), 0::bigint, '3. ledger still balanced');

-- =========================================================================
-- 4. Wrong amounts and unknown payments
-- =========================================================================
insert into public.payments (community_id, checkout_id, payer_user_id, provider, mode, amount_minor, currency, provider_reference, status)
  values (pg_temp.fx('A'), pg_temp.ck(), pg_temp.fx('dave'), 'test', 'test', 1250000, 'JMD', 'ref_4', 'pending');
select is(pg_temp.apply('ev_6', 'ref_4', 'succeeded', 100), 'mismatch', '4. a different amount is a mismatch');
select results_eq($$ select status, failure_code from public.payments where provider_reference = 'ref_4' $$,
  $$ values ('unknown'::text, 'amount_mismatch'::text) $$, '4. held for review');
select is(pg_temp.apply('ev_7', 'ref_4', 'succeeded', 1250000), 'ignored', '4. and not settled by a later event');
select is(pg_temp.apply('ev_8', 'nope', 'succeeded', 1), 'unknown_payment', '4. unknown references change nothing');
select throws_ok($$ select pg_temp.apply('ev_9', 'ref_4', 'paid', 1) $$, '22023', null, '4. unknown statuses are refused');

-- =========================================================================
-- 5. Privacy
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select is((select count(*)::int from public.payments), 4, '5. the payer sees their payments');
select throws_ok($$ select provider_reference from public.payments $$, '42501', null, '5. but not provider references');
select throws_ok($$ select 1 from public.payment_events $$, '42501', null, '5. payment events are server-only');
select throws_ok($$ select 1 from public.ledger_entries $$, '42501', null, '5. the ledger is server-only');
select throws_ok($$ select 1 from public.test_provider_sessions $$, '42501', null, '5. test provider state is server-only');
select pg_temp.login(pg_temp.fx('carol'));
select is_empty($$ select 1 from public.payments $$, '5. sellers do not see the buyer''s payments');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select 1 from public.refunds $$, '5. other communities see no refunds');

select * from finish();
rollback;
