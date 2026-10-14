-- Marketplace Stage I (migration 37): refund requests (buyer, capped, one at a time), seller decisions (partial, once), provider-confirmed completion and ledger, disputes (parties and managers, decided by a non-party manager), community refund settings.
begin;
create extension if not exists pgtap with schema extensions;

select plan(40);

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

-- dave buys 2 Radios from carol (pickup) and 1 Book from erin (pickup); then
-- a second checkout: 1 Lamp from carol (delivery). Both paid via the
-- service-role payment API (as the webhook would).
reset role;
insert into public.delivery_options (seller_profile_id, community_id, fee_minor, parishes)
  values ('5e000000-0000-4000-8000-000000000002', pg_temp.fx('A'), 20000, '{}')
  on conflict (seller_profile_id) do nothing;
select pg_temp.login(pg_temp.fx('dave'));
insert into public.addresses (recipient_name, phone, line1, town, parish, is_default) values ('Dave D', '876 555 0101', '1 Hope Rd', 'Kingston', 'Kingston', true);
select public.cart_set_item('1a000000-0000-4000-8000-000000000001', 2);
select public.cart_set_item('1a000000-0000-4000-8000-000000000003', 1);
select public.checkout_create(pg_temp.fx('A'), '00000000-0000-4000-8000-0000000000e1', pg_temp.choices('pickup', 'pickup'),
  null, 'Dave D', '876 555 0101', 1250000, 'v1');
select public.cart_set_item('1a000000-0000-4000-8000-000000000002', 1);
select public.checkout_create(pg_temp.fx('A'), '00000000-0000-4000-8000-0000000000e2',
  jsonb_build_array(jsonb_build_object('seller_profile_id', '5e000000-0000-4000-8000-000000000001', 'method', 'seller_delivery')),
  (select id from public.addresses), 'Dave D', '876 555 0101', 337500, 'v1');
reset role;
create function pg_temp.ck(p text) returns uuid language sql security definer as $$ select id from public.checkouts where client_request_id = ('00000000-0000-4000-8000-0000000000' || p)::uuid $$;
create function pg_temp.pay(p text) returns text language plpgsql as $$
declare v uuid;
begin
  select payment_id into v from public.payment_begin(pg_temp.fx('dave'), pg_temp.ck(p), 'test', 'test');
  perform public.payment_attach_session(v, 'ref_' || p, 'https://pay.example/' || p, now() + interval '15 minutes');
  return public.payment_apply_event('test', 'ev_' || p, 'ref_' || p, 'succeeded',
    (select total_minor from public.checkouts where id = pg_temp.ck(p)), 'JMD', now(), null, 'webhook');
end $$;
create function pg_temp.ord(p text, p_seller text) returns uuid language sql security definer as $$
  select id from public.orders where checkout_id = pg_temp.ck(p) and seller_user_id = pg_temp.fx(p_seller) $$;
create function pg_temp.status(p_order uuid) returns text language sql security definer as $$ select status from public.orders where id = p_order $$;
create function pg_temp.on_hand(p_listing text) returns int language sql security definer as $$ select on_hand from public.inventory where listing_id = p_listing::uuid $$;


reset role;
select pg_temp.pay('e1');
select pg_temp.pay('e2');
create function pg_temp.refund_of(p_order uuid) returns uuid language sql security definer as $$
  select id from public.refunds where order_id = p_order order by created_at desc limit 1 $$;
create function pg_temp.rstatus(p_refund uuid) returns text language sql security definer as $$ select status from public.refunds where id = p_refund $$;
select pg_temp.login(pg_temp.fx('carol'));
select public.order_accept(pg_temp.ord('e1', 'carol'));
select public.order_accept(pg_temp.ord('e2', 'carol'));

-- =========================================================================
-- 1. Requests: buyer only, within what is left, one at a time
-- =========================================================================
select throws_ok(format($$ select public.refund_request(%L, 'I want my money back') $$, pg_temp.ord('e1', 'carol')), 'P0002', null,
  '1. the seller cannot request a refund');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(format($$ select public.refund_request(%L, 'I want my money back', 99999999) $$, pg_temp.ord('e1', 'carol')), '22023', null,
  '1. not more than the order');
select throws_ok(format($$ select public.refund_request(%L, 'I want my money back') $$, pg_temp.ord('e1', 'erin')), '22023', null,
  '1. not for an order the seller has not accepted (the buyer cancels instead)');
select lives_ok(format($$ select public.refund_request(%L, 'One radio does not turn on', 500000) $$, pg_temp.ord('e1', 'carol')), '1. a partial request');
select throws_ok(format($$ select public.refund_request(%L, 'And another one please') $$, pg_temp.ord('e1', 'carol')), '22023',
  'there is already a refund request waiting for the seller', '1. one open request at a time');
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select 1 from public.refunds $$, '1. other communities see no refunds');

-- =========================================================================
-- 2. Decisions: the order's seller only, never more than requested, once
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
select throws_ok(format($$ select public.refund_decide(%L, true) $$, pg_temp.refund_of(pg_temp.ord('e1', 'carol'))), 'P0002', null,
  '2. another seller cannot decide');
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(format($$ select public.refund_decide(%L, true, 600000) $$, pg_temp.refund_of(pg_temp.ord('e1', 'carol'))), '22023', null,
  '2. not more than requested');
select lives_ok(format($$ select public.refund_decide(%L, true, 250000, 'Half') $$, pg_temp.refund_of(pg_temp.ord('e1', 'carol'))), '2. approved for less');
select throws_ok(format($$ select public.refund_decide(%L, false, null, 'changed my mind') $$, pg_temp.refund_of(pg_temp.ord('e1', 'carol'))), '22023',
  'this refund was already decided', '2. decided once');
select throws_ok($$ update public.refunds set status = 'succeeded' $$, '42501', null, '2. nobody marks a refund succeeded directly');

-- =========================================================================
-- 3. Processing: only the provider's success completes a refund
-- =========================================================================
set local role service_role;
select is((select count(*)::int from public.refunds_claim(10) where refund_id = pg_temp.refund_of(pg_temp.ord('e1', 'carol'))), 1, '3. approved refunds are claimed');
select is(pg_temp.rstatus(pg_temp.refund_of(pg_temp.ord('e1', 'carol'))), 'processing', '3. processing is not refunded');
select is((select count(*)::int from public.refunds_claim(10) where refund_id = pg_temp.refund_of(pg_temp.ord('e1', 'carol'))), 0, '3. not claimed twice');
select is(public.refund_apply_result(pg_temp.refund_of(pg_temp.ord('e1', 'carol')), 'pending', 'rf_1', null), 'pending', '3. pending at the provider');
select is((select count(*)::int from public.ledger_transactions where kind = 'refund' and community_id = pg_temp.fx('A')), 0, '3. no money moved yet');
select is(public.refund_apply_result(pg_temp.refund_of(pg_temp.ord('e1', 'carol')), 'succeeded', 'rf_1', null), 'succeeded', '3. the provider confirms');
select is(public.refund_apply_result(pg_temp.refund_of(pg_temp.ord('e1', 'carol')), 'succeeded', 'rf_1', null), 'ignored', '3. a repeated result changes nothing');
select is((select count(*)::int from public.ledger_transactions where kind = 'refund' and community_id = pg_temp.fx('A')), 1, '3. one refund transaction');
select is((select coalesce(sum(e.amount_minor), 0)::bigint from public.ledger_entries e join public.ledger_transactions t on t.id = e.transaction_id
           where t.community_id = pg_temp.fx('A')), 0::bigint, '3. the ledger balances');
select is((select status from public.checkouts where id = pg_temp.ck('e1')), 'partially_refunded', '3. the checkout is partially refunded');
select throws_ok($$ select public.refund_apply_result(gen_random_uuid(), 'paid', null, null) $$, '22023', null, '3. unknown results are refused');
reset role;
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok($$ select * from public.refunds_claim(1) $$, '42501', null, '3. users cannot claim refunds');

-- =========================================================================
-- 4. Disputes: parties and managers; decided by a manager who is not a party
-- =========================================================================
select lives_ok(format($$ select public.refund_request(%L, 'The lamp flickers all the time') $$, pg_temp.ord('e2', 'carol')), '4. request');
select pg_temp.login(pg_temp.fx('carol'));
select lives_ok(format($$ select public.refund_decide(%L, false, null, 'Works when tested') $$, pg_temp.refund_of(pg_temp.ord('e2', 'carol'))), '4. declined');
select pg_temp.login(pg_temp.fx('dave'));
select lives_ok(format($$ select public.dispute_open(%L, 'The lamp flickers; seller refused') $$, pg_temp.ord('e2', 'carol')), '4. the buyer opens a dispute');
select throws_ok(format($$ select public.dispute_open(%L, 'The lamp flickers; seller refused') $$, pg_temp.ord('e2', 'carol')), '22023', null, '4. one open dispute per order');
reset role;
select is((select count(*)::int from public.notifications where type = 'dispute' and user_id in (pg_temp.fx('alice'), pg_temp.fx('erin'))), 2,
  '4. the community''s marketplace managers are told');
select pg_temp.login(pg_temp.fx('grace'));
select is_empty($$ select 1 from public.disputes $$, '4. a pending member sees no disputes');
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok($$ select public.dispute_resolve((select id from public.disputes), false, 0, 'I win') $$, 'P0002', null, '4. the seller cannot decide');
select lives_ok($$ select public.dispute_add_message((select id from public.disputes), 'Tested before handover') $$, '4. the seller adds their side');
select pg_temp.login(pg_temp.fx('alice'));
select is((select count(*)::int from public.dispute_messages), 1, '4. the manager reads the messages');
select throws_ok($$ select public.dispute_resolve((select id from public.disputes), true, 99999999, 'Refund all') $$, '22023', null,
  '4. a dispute refund is capped at what was paid');
select lives_ok($$ select public.dispute_resolve((select id from public.disputes), true, 100000, 'Partial refund for the flicker') $$, '4. the manager decides');
select results_eq($$ select status, refund_id is not null from public.disputes $$, $$ values ('resolved_refund'::text, true) $$, '4. resolved with a refund');
select results_eq(format($$ select kind, status, amount_minor from public.refunds where id = (select refund_id from public.disputes) $$),
  $$ values ('dispute'::text, 'approved'::text, 100000::bigint) $$, '4. an approved refund, still to be processed');
select is((select count(*)::int from public.audit_logs where action in ('dispute.opened', 'dispute.resolved') and community_id = pg_temp.fx('A')), 2, '4. audited');

-- =========================================================================
-- 5. Settings
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok($$ select public.refund_policy_save(pg_temp.fx('A'), false, 7, null) $$, '42501', null, '5. members cannot change refund settings');
select pg_temp.login(pg_temp.fx('alice'));
select lives_ok($$ select public.refund_policy_save(pg_temp.fx('A'), true, 0, 'Returns within 7 days, unused.') $$, '5. a manager saves the community''s own policy');
reset role;
update public.orders set status = 'completed', completed_at = now() - interval '1 day' where id = pg_temp.ord('e1', 'erin');
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(format($$ select public.refund_request(%L, 'Too late to ask now?') $$, pg_temp.ord('e1', 'erin')), '22023',
  'the time to request a refund for this order has passed', '5. the community''s window applies');

select * from finish();
rollback;
