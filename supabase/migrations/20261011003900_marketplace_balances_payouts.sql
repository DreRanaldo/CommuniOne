-- Marketplace Stage K / Migration 39: seller balances, statements and
-- payout RECORDS.
--
-- Balances come only from the ledger (append-only, double-entry). There is
-- no commission (D4), no fee split (D5) and no hold period (D7) yet, so a
-- seller's balance is simply: captured payments for their orders and
-- bookings, minus completed refunds, minus payouts recorded.
--
-- CommuniOne does NOT pay sellers automatically: no provider payout or
-- split-payment feature is connected or verified, and nothing here claims
-- escrow. A payout is recorded by an operator (service role) AFTER money
-- was sent outside the app (for example a bank transfer), with its
-- external reference. Recording it never moves money by itself.

create table public.payouts (
  id                 uuid primary key default gen_random_uuid(),
  community_id       uuid not null references public.communities (id) on delete restrict,
  -- Pseudonymous like the ledger: kept after an account deletion.
  seller_user_id     uuid not null,
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null default 'JMD',
  method             text not null check (method in ('bank_transfer', 'other')),
  external_reference text not null check (char_length(btrim(external_reference)) between 3 and 120),
  note               text check (char_length(note) <= 500),
  recorded_by        text not null check (char_length(recorded_by) between 1 and 120),
  created_at         timestamptz not null default now()
);

create index payouts_seller_idx on public.payouts (seller_user_id, community_id, created_at desc);
create trigger payouts_append_only before update or delete on public.payouts
  for each row execute function private.forbid_change();

-- ---------------------------------------------------------------------------
-- A seller's own balance and statement
-- ---------------------------------------------------------------------------
create or replace function public.seller_balance(p_community_id uuid)
returns table (currency text, earned_minor bigint, refunded_minor bigint, paid_out_minor bigint, balance_minor bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select a.currency::text,
         coalesce(-sum(e.amount_minor) filter (where t.kind = 'payment_captured'), 0)::bigint,
         coalesce(sum(e.amount_minor) filter (where t.kind = 'refund'), 0)::bigint,
         coalesce(sum(e.amount_minor) filter (where t.kind = 'payout'), 0)::bigint,
         coalesce(-sum(e.amount_minor), 0)::bigint
  from public.ledger_accounts a
  join public.ledger_entries e on e.account_id = a.id
  join public.ledger_transactions t on t.id = e.transaction_id
  where a.kind = 'seller_payable' and a.community_id = p_community_id
    and a.owner_user_id = (select private.current_active_user_id())
  group by a.currency;
$$;

-- Ledger lines for the caller's seller account, newest first (keyset paging).
create or replace function public.seller_statement(p_community_id uuid, p_before timestamptz default null, p_limit integer default 50)
returns table (entry_id uuid, created_at timestamptz, kind text, reference_type text, reference_id uuid, amount_minor bigint, currency text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.created_at, t.kind, t.reference_type, t.reference_id, -e.amount_minor, a.currency::text
  from public.ledger_accounts a
  join public.ledger_entries e on e.account_id = a.id
  join public.ledger_transactions t on t.id = e.transaction_id
  where a.kind = 'seller_payable' and a.community_id = p_community_id
    and a.owner_user_id = (select private.current_active_user_id())
    and (p_before is null or e.created_at < p_before)
  order by e.created_at desc, e.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- ---------------------------------------------------------------------------
-- Operators (service role)
-- ---------------------------------------------------------------------------
-- Records money already sent to a seller outside the app. Refuses more than
-- the seller's current balance.
create or replace function public.payout_record(
  p_community_id uuid, p_seller_user_id uuid, p_amount_minor bigint, p_method text,
  p_external_reference text, p_recorded_by text, p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_id      uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('payout:' || p_community_id || ':' || p_seller_user_id, 0));
  select coalesce(-sum(e.amount_minor), 0) into v_balance
  from public.ledger_accounts a join public.ledger_entries e on e.account_id = a.id
  where a.kind = 'seller_payable' and a.community_id = p_community_id and a.owner_user_id = p_seller_user_id and a.currency = 'JMD';
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > v_balance then
    raise exception 'a payout must be between 1 and the seller''s balance (%)', v_balance using errcode = '22023';
  end if;
  insert into public.payouts (community_id, seller_user_id, amount_minor, method, external_reference, recorded_by, note)
  values (p_community_id, p_seller_user_id, p_amount_minor, p_method, btrim(p_external_reference), btrim(p_recorded_by), nullif(btrim(p_note), ''))
  returning id into v_id;
  perform private.post_ledger('payout', 'payout', v_id, p_community_id, 'JMD',
    jsonb_build_array(jsonb_build_object('account', 'seller_payable', 'owner', p_seller_user_id, 'amount_minor', p_amount_minor),
                      jsonb_build_object('account', 'platform_clearing', 'owner', null, 'amount_minor', -p_amount_minor)));
  perform private.record_audit_event(p_community_id, 'payout.recorded', 'payout', v_id,
    jsonb_build_object('amount_minor', p_amount_minor, 'method', p_method));
  perform private.create_notification(p_seller_user_id, p_community_id, 'payment', 'Payout recorded',
    'A payout to you was recorded. Check your earnings for details.', jsonb_build_object('payout_id', v_id), 'payout:' || v_id);
  return v_id;
end;
$$;

-- Per community: what is held in clearing, owed to sellers, refunded and paid out.
create or replace function public.ledger_summary(p_community_id uuid)
returns table (account_kind text, currency text, balance_minor bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select a.kind, a.currency::text, coalesce(sum(e.amount_minor), 0)::bigint
  from public.ledger_accounts a join public.ledger_entries e on e.account_id = a.id
  where a.community_id = p_community_id
  group by a.kind, a.currency
  order by a.kind;
$$;

revoke all on function public.seller_balance(uuid)                                            from public, anon, authenticated;
revoke all on function public.seller_statement(uuid, timestamptz, integer)                    from public, anon, authenticated;
revoke all on function public.payout_record(uuid, uuid, bigint, text, text, text, text)      from public, anon, authenticated;
revoke all on function public.ledger_summary(uuid)                                            from public, anon, authenticated;
grant execute on function public.seller_balance(uuid)                                         to authenticated;
grant execute on function public.seller_statement(uuid, timestamptz, integer)                 to authenticated;
grant execute on function public.payout_record(uuid, uuid, bigint, text, text, text, text)   to service_role;
grant execute on function public.ledger_summary(uuid)                                         to service_role;

revoke all on table public.payouts from public, anon, authenticated;
grant all on table public.payouts to service_role;
alter table public.payouts enable row level security;
grant select (id, community_id, seller_user_id, amount_minor, currency, method, external_reference, created_at) on public.payouts to authenticated;
create policy payouts_select_own on public.payouts
  for select to authenticated using (seller_user_id = (select private.current_active_user_id()));

insert into public.audit_actions (action, entity_type, description) values
  ('payout.recorded', 'payout', 'An operator recorded money sent to a seller outside the app')
on conflict (action) do nothing;
