-- Marketplace Stage I / Migration 37: refund requests, seller decisions,
-- disputes, and refund processing through the payment adapter.
--
-- A refund is COMPLETED only when the payment provider confirms it
-- (refund_apply_result with 'succeeded'). Requests, approvals and
-- "processing" are never shown as refunded money.
--
--   requested ──seller approves (full or partial)──> approved
--   requested ──seller rejects──> rejected ──buyer──> dispute
--   approved ──refunds-process claims──> processing ──provider──> succeeded | pending | failed
--   pending ──later result──> succeeded | failed
--   failed ──operator retry──> approved
--
-- The request window is a per-community SETTING, not a return policy:
-- CommuniOne does not invent one (decision D6). A community can publish
-- its own policy text, which is shown to buyers as written.

alter table public.refunds drop constraint refunds_kind_check;
alter table public.refunds add constraint refunds_kind_check check (kind in ('customer', 'automatic', 'dispute'));

-- ---------------------------------------------------------------------------
-- Per-community refund settings (marketplace.manage)
-- ---------------------------------------------------------------------------
create table public.refund_policies (
  community_id        uuid primary key references public.communities (id) on delete cascade,
  requests_enabled    boolean not null default true,
  -- Days after an order completes during which a refund can still be requested.
  request_window_days integer not null default 14 check (request_window_days between 0 and 365),
  -- The community's own policy, shown as written. Null: none published.
  policy_text         text check (char_length(policy_text) <= 4000),
  updated_by          uuid references public.profiles (id) on delete set null,
  updated_at          timestamptz not null default now()
);

create trigger refund_policies_set_updated_at before update on public.refund_policies
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Disputes: a buyer escalates to the community's marketplace managers
-- ---------------------------------------------------------------------------
create table public.disputes (
  id              uuid primary key default gen_random_uuid(),
  community_id    uuid not null references public.communities (id) on delete restrict,
  order_id        uuid not null references public.orders (id) on delete restrict,
  buyer_user_id   uuid references public.profiles (id) on delete set null,
  seller_user_id  uuid references public.profiles (id) on delete set null,
  reason          text not null check (char_length(btrim(reason)) between 10 and 2000),
  status          text not null default 'open' check (status in ('open', 'resolved_refund', 'resolved_no_refund', 'withdrawn')),
  resolution_note text check (char_length(resolution_note) <= 1000),
  resolved_by     uuid references public.profiles (id) on delete set null,
  refund_id       uuid references public.refunds (id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create unique index disputes_one_open_per_order on public.disputes (order_id) where status = 'open';
create index disputes_community_idx on public.disputes (community_id, status, created_at desc);

create trigger disputes_set_updated_at before update on public.disputes
  for each row execute function private.set_updated_at();

create table public.dispute_messages (
  id            uuid primary key default gen_random_uuid(),
  dispute_id    uuid not null references public.disputes (id) on delete restrict,
  author_user_id uuid references public.profiles (id) on delete set null,
  body          text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at    timestamptz not null default now()
);

create index dispute_messages_dispute_idx on public.dispute_messages (dispute_id, created_at);
create trigger dispute_messages_append_only before update or delete on public.dispute_messages
  for each row execute function private.forbid_change();

-- Parties and the community's marketplace managers.
create or replace function private.can_view_dispute(p_dispute_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.disputes d
    where d.id = p_dispute_id
      and (d.buyer_user_id = (select private.current_active_user_id())
           or d.seller_user_id = (select private.current_active_user_id())
           or public.has_community_permission(d.community_id, 'marketplace.manage'))
  );
$$;

revoke all on function private.can_view_dispute(uuid) from public, anon, authenticated;
grant execute on function private.can_view_dispute(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Buyer: request a refund (full or part of what is left)
-- ---------------------------------------------------------------------------
create or replace function public.refund_request(p_order_id uuid, p_reason text, p_amount_minor bigint default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me      uuid := private.current_active_user_id();
  v_order   public.orders;
  v_policy  public.refund_policies;
  v_payment uuid;
  v_left    bigint;
  v_id      uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_me is null or v_order.id is null or v_order.buyer_user_id is distinct from v_me then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if v_order.status not in ('accepted', 'processing', 'ready_for_pickup', 'out_for_delivery', 'delivery_failed', 'delivered', 'completed') then
    raise exception 'a refund cannot be requested for an order that is %', replace(v_order.status, '_', ' ') using errcode = '22023';
  end if;
  select * into v_policy from public.refund_policies where community_id = v_order.community_id;
  if v_policy.community_id is not null and not v_policy.requests_enabled then
    raise exception 'refund requests are turned off in this community; contact the seller' using errcode = '22023';
  end if;
  if v_order.status = 'completed'
     and v_order.completed_at < now() - make_interval(days => coalesce(v_policy.request_window_days, 14)) then
    raise exception 'the time to request a refund for this order has passed' using errcode = '22023';
  end if;
  if exists (select 1 from public.refunds r where r.order_id = p_order_id and r.status = 'requested') then
    raise exception 'there is already a refund request waiting for the seller' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 500 then
    raise exception 'describe the problem (10 to 500 characters)' using errcode = '22023';
  end if;
  perform private.enforce_rate_limit('refund.request');

  select p.id into v_payment from public.payments p
  where p.checkout_id = v_order.checkout_id and p.status = 'succeeded' and p.failure_code is null limit 1;
  select v_order.total_minor - coalesce(sum(r.amount_minor), 0) into v_left
  from public.refunds r where r.order_id = p_order_id and r.status not in ('rejected', 'failed');
  if v_payment is null or v_left <= 0 then
    raise exception 'this order has nothing left to refund' using errcode = '22023';
  end if;
  if p_amount_minor is not null and (p_amount_minor <= 0 or p_amount_minor > v_left) then
    raise exception 'a refund can be between 1 and % (what is left of this order)', v_left using errcode = '22023';
  end if;

  v_id := private.create_refund(v_payment, p_order_id, coalesce(p_amount_minor, v_left), btrim(p_reason), 'customer', 'requested', v_me);
  if v_order.seller_user_id is not null then
    perform private.create_notification(v_order.seller_user_id, v_order.community_id, 'refund', 'Refund requested',
      'A buyer asked for a refund. Review it and approve or decline.',
      jsonb_build_object('order_id', p_order_id, 'refund_id', v_id), 'refund:' || v_id || ':requested');
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Seller: approve (full or partial) or decline a request
-- ---------------------------------------------------------------------------
create or replace function public.refund_decide(p_refund_id uuid, p_approve boolean, p_amount_minor bigint default null, p_note text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me     uuid := private.current_active_user_id();
  v_refund public.refunds;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if v_me is null or v_refund.id is null or v_refund.seller_user_id is distinct from v_me then
    raise exception 'refund not found' using errcode = 'P0002';
  end if;
  if v_refund.status <> 'requested' then
    raise exception 'this refund was already decided' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    raise exception 'the note is too long' using errcode = '22023';
  end if;
  if p_approve then
    if p_amount_minor is not null then
      if p_amount_minor <= 0 or p_amount_minor > v_refund.amount_minor then
        raise exception 'approve between 1 and % (the amount requested)', v_refund.amount_minor using errcode = '22023';
      end if;
      update public.refunds set amount_minor = p_amount_minor where id = p_refund_id;
    end if;
    update public.refunds set decided_by = v_me, decision_note = nullif(btrim(p_note), '') where id = p_refund_id;
    perform private.refund_transition(p_refund_id, 'approved', nullif(btrim(p_note), ''));
  else
    if p_note is null or char_length(btrim(p_note)) < 3 then
      raise exception 'tell the buyer why (at least 3 characters)' using errcode = '22023';
    end if;
    update public.refunds set decided_by = v_me, decision_note = btrim(p_note) where id = p_refund_id;
    perform private.refund_transition(p_refund_id, 'rejected', btrim(p_note));
  end if;
  if v_refund.buyer_user_id is not null then
    perform private.create_notification(v_refund.buyer_user_id, v_refund.community_id, 'refund',
      case when p_approve then 'Refund approved' else 'Refund declined' end,
      case when p_approve then 'The seller approved your refund. You will be told when the payment provider completes it.'
           else 'The seller declined your refund request. You can open a dispute if you disagree.' end,
      jsonb_build_object('order_id', v_refund.order_id, 'refund_id', p_refund_id), 'refund:' || p_refund_id || ':decided');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------
create or replace function public.dispute_open(p_order_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me    uuid := private.current_active_user_id();
  v_order public.orders;
  v_id    uuid;
  v_mgr   record;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_me is null or v_order.id is null or v_order.buyer_user_id is distinct from v_me then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if v_order.status in ('pending_payment', 'cancelled', 'rejected') then
    raise exception 'there is nothing to dispute on this order' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 10 and 2000 then
    raise exception 'describe the problem (10 to 2000 characters)' using errcode = '22023';
  end if;
  if exists (select 1 from public.disputes d where d.order_id = p_order_id and d.status = 'open') then
    raise exception 'this order already has an open dispute' using errcode = '22023';
  end if;
  perform private.enforce_rate_limit('dispute.open');
  insert into public.disputes (community_id, order_id, buyer_user_id, seller_user_id, reason)
  values (v_order.community_id, p_order_id, v_me, v_order.seller_user_id, btrim(p_reason))
  returning id into v_id;
  perform private.record_audit_event(v_order.community_id, 'dispute.opened', 'dispute', v_id, jsonb_build_object('order_id', p_order_id));
  if v_order.seller_user_id is not null then
    perform private.create_notification(v_order.seller_user_id, v_order.community_id, 'dispute', 'A buyer opened a dispute',
      'A community marketplace manager will review it. You can add your side.',
      jsonb_build_object('dispute_id', v_id, 'order_id', p_order_id), 'dispute:' || v_id || ':seller');
  end if;
  for v_mgr in
    select distinct m.user_id from public.memberships m
    where m.community_id = v_order.community_id and m.status = 'active' and m.user_id <> v_me
      and m.user_id is distinct from v_order.seller_user_id
      and exists (select 1 from public.membership_roles mr join public.role_permissions rp on rp.role_id = mr.role_id
                  join public.permissions p on p.id = rp.permission_id
                  where mr.membership_id = m.id and p.key = 'marketplace.manage')
  loop
    perform private.create_notification(v_mgr.user_id, v_order.community_id, 'dispute', 'Marketplace dispute to review',
      'A buyer and seller need a decision.', jsonb_build_object('dispute_id', v_id), 'dispute:' || v_id || ':manager:' || v_mgr.user_id);
  end loop;
  return v_id;
end;
$$;

create or replace function public.dispute_add_message(p_dispute_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.can_view_dispute(p_dispute_id) then
    raise exception 'dispute not found' using errcode = 'P0002';
  end if;
  if (select status from public.disputes where id = p_dispute_id) <> 'open' then
    raise exception 'this dispute is closed' using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 2000 then
    raise exception 'write a message (up to 2000 characters)' using errcode = '22023';
  end if;
  perform private.enforce_rate_limit('dispute.message');
  insert into public.dispute_messages (dispute_id, author_user_id, body)
  values (p_dispute_id, private.current_active_user_id(), btrim(p_body))
  returning id into v_id;
  return v_id;
end;
$$;

-- A community marketplace manager decides. A refund outcome creates an
-- approved refund (capped at what is left); it completes only when processed.
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
  v_order   public.orders;
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
    select * into v_order from public.orders where id = v_dispute.order_id;
    select p.id into v_payment from public.payments p
    where p.checkout_id = v_order.checkout_id and p.status = 'succeeded' and p.failure_code is null limit 1;
    if v_payment is null then
      raise exception 'this order has no captured payment to refund' using errcode = '22023';
    end if;
    -- Any open request is superseded by the decision.
    update public.refunds set decision_note = 'Superseded by dispute decision' where order_id = v_order.id and status = 'requested';
    perform private.refund_transition(r.id, 'rejected', 'Superseded by dispute decision')
    from public.refunds r where r.order_id = v_order.id and r.status = 'requested';
    v_refund := private.create_refund(v_payment, v_order.id, p_amount_minor, 'Dispute decision: ' || btrim(p_note), 'dispute', 'approved', v_me);
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

create or replace function public.dispute_withdraw(p_dispute_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.disputes set status = 'withdrawn', resolved_at = now()
  where id = p_dispute_id and status = 'open' and buyer_user_id = private.current_active_user_id();
  if not found then
    raise exception 'dispute not found or already closed' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create or replace function public.refund_policy_save(p_community_id uuid, p_requests_enabled boolean, p_request_window_days integer, p_policy_text text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.has_community_permission(p_community_id, 'marketplace.manage') then
    raise exception 'marketplace.manage is required' using errcode = '42501';
  end if;
  if p_request_window_days is null or p_request_window_days not between 0 and 365 then
    raise exception 'the request window is 0 to 365 days' using errcode = '22023';
  end if;
  insert into public.refund_policies (community_id, requests_enabled, request_window_days, policy_text, updated_by)
  values (p_community_id, coalesce(p_requests_enabled, true), p_request_window_days, nullif(btrim(p_policy_text), ''), private.current_active_user_id())
  on conflict (community_id) do update
    set requests_enabled = excluded.requests_enabled, request_window_days = excluded.request_window_days,
        policy_text = excluded.policy_text, updated_by = excluded.updated_by;
  perform private.record_audit_event(p_community_id, 'refund_policy.updated', 'community', p_community_id,
    jsonb_build_object('requests_enabled', p_requests_enabled, 'request_window_days', p_request_window_days));
end;
$$;

-- ---------------------------------------------------------------------------
-- Processing (refunds-process Edge Function, service role)
-- ---------------------------------------------------------------------------
-- Claims approved refunds (and long-pending ones) for the provider.
create or replace function public.refunds_claim(p_limit integer default 20)
returns table (refund_id uuid, provider text, provider_reference text, amount_minor bigint, currency text, status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select r.id, p.provider, p.provider_reference, r.amount_minor, r.currency::text as currency, r.status
    from public.refunds r join public.payments p on p.id = r.payment_id
    where r.status = 'approved' or (r.status in ('processing', 'pending') and r.updated_at < now() - interval '10 minutes')
    order by r.updated_at
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
    for update of r skip locked
  loop
    update public.refunds set attempts = attempts + 1 where id = v_row.id;
    perform private.refund_transition(v_row.id, 'processing', null);
    refund_id := v_row.id; provider := v_row.provider; provider_reference := v_row.provider_reference;
    amount_minor := v_row.amount_minor; currency := v_row.currency; status := v_row.status;
    return next;
  end loop;
end;
$$;

-- Records the provider's answer. Only 'succeeded' completes a refund and
-- moves money in the ledger.
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
    -- The provider could not be reached: try again later.
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
  -- Ledger: money leaves clearing back to the buyer; it comes out of what
  -- the seller is owed (or platform revenue for a duplicate payment).
  perform private.post_ledger('refund', 'refund', p_refund_id, v_refund.community_id, v_refund.currency,
    jsonb_build_array(
      jsonb_build_object('account', 'platform_clearing', 'owner', null, 'amount_minor', -v_refund.amount_minor),
      case when v_refund.order_id is not null and v_refund.seller_user_id is not null
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
      jsonb_build_object('order_id', v_refund.order_id, 'refund_id', p_refund_id), 'refund:' || p_refund_id || ':succeeded');
  end if;
  return 'succeeded';
end;
$$;

-- An operator puts a failed refund back in the queue.
create or replace function public.refund_retry(p_refund_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select status from public.refunds where id = p_refund_id) is distinct from 'failed' then
    raise exception 'only a failed refund can be retried' using errcode = '22023';
  end if;
  perform private.refund_transition(p_refund_id, 'approved', 'Retry requested by an operator');
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on function public.refund_request(uuid, text, bigint)                 from public, anon, authenticated;
revoke all on function public.refund_decide(uuid, boolean, bigint, text)         from public, anon, authenticated;
revoke all on function public.dispute_open(uuid, text)                           from public, anon, authenticated;
revoke all on function public.dispute_add_message(uuid, text)                    from public, anon, authenticated;
revoke all on function public.dispute_resolve(uuid, boolean, bigint, text)       from public, anon, authenticated;
revoke all on function public.dispute_withdraw(uuid)                             from public, anon, authenticated;
revoke all on function public.refund_policy_save(uuid, boolean, integer, text)   from public, anon, authenticated;
revoke all on function public.refunds_claim(integer)                             from public, anon, authenticated;
revoke all on function public.refund_apply_result(uuid, text, text, text)        from public, anon, authenticated;
revoke all on function public.refund_retry(uuid)                                 from public, anon, authenticated;
grant execute on function public.refund_request(uuid, text, bigint)               to authenticated;
grant execute on function public.refund_decide(uuid, boolean, bigint, text)       to authenticated;
grant execute on function public.dispute_open(uuid, text)                         to authenticated;
grant execute on function public.dispute_add_message(uuid, text)                  to authenticated;
grant execute on function public.dispute_resolve(uuid, boolean, bigint, text)     to authenticated;
grant execute on function public.dispute_withdraw(uuid)                           to authenticated;
grant execute on function public.refund_policy_save(uuid, boolean, integer, text) to authenticated;
grant execute on function public.refunds_claim(integer)                           to service_role;
grant execute on function public.refund_apply_result(uuid, text, text, text)      to service_role;
grant execute on function public.refund_retry(uuid)                               to service_role;

revoke all on table public.refund_policies, public.disputes, public.dispute_messages from public, anon, authenticated;
grant all on table public.refund_policies, public.disputes, public.dispute_messages to service_role;
alter table public.refund_policies  enable row level security;
alter table public.disputes         enable row level security;
alter table public.dispute_messages enable row level security;

grant select on public.refund_policies to authenticated;
create policy refund_policies_select_members on public.refund_policies
  for select to authenticated using (public.has_community_permission(community_id, 'marketplace.view'));

grant select on public.disputes, public.dispute_messages to authenticated;
create policy disputes_select_involved on public.disputes
  for select to authenticated using (private.can_view_dispute(id));
create policy dispute_messages_select_involved on public.dispute_messages
  for select to authenticated using (private.can_view_dispute(dispute_id));

-- Managers also see the refunds of disputes they handle.
create policy refunds_select_managers on public.refunds
  for select to authenticated
  using (exists (select 1 from public.disputes d where d.order_id = refunds.order_id
                 and public.has_community_permission(d.community_id, 'marketplace.manage')));

insert into private.rate_limit_rules (action, max_count, window_seconds, description) values
  ('refund.request',  10, 86400, 'Refund requests per user per day'),
  ('dispute.open',     5, 86400, 'Disputes opened per user per day'),
  ('dispute.message', 60,  3600, 'Dispute messages per user per hour')
on conflict (action) do nothing;

insert into public.audit_actions (action, entity_type, description) values
  ('dispute.opened',        'dispute',   'A buyer opened a marketplace dispute'),
  ('dispute.resolved',      'dispute',   'A marketplace manager decided a dispute'),
  ('refund.succeeded',      'refund',    'The payment provider completed a refund'),
  ('refund.failed',         'refund',    'The payment provider refused or failed a refund'),
  ('refund_policy.updated', 'community', 'Marketplace refund settings changed')
on conflict (action) do nothing;
