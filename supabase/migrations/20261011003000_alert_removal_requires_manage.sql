-- RN-16 / Migration 30: only alert managers remove published alerts
--
-- Until now an author holding alerts.create (but not alerts.manage) could
-- end, cancel and archive her own PUBLISHED alerts. Published alerts belong
-- to the community: from now on taking one down (published -> expired |
-- cancelled) or archiving it needs alerts.manage (Owners and Admins in the
-- seed templates). Authors keep full control of their own drafts (edit,
-- publish, discard) and may still correct the text of their published alert.
--
-- Ordinary members never held alerts.create, so they could not touch any
-- alert before this migration either; this closes the remaining gap for
-- custom roles that can issue alerts without managing them.
--
-- The rule is added as a separate BEFORE UPDATE trigger, so the Stage 7
-- write trigger (private.enforce_alert_write) is unchanged. Triggers fire in
-- name order: alerts_enforce_write runs first (immutability, transition
-- validity), then alerts_restrict_removal.

create or replace function private.restrict_alert_removal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Trusted server code (service_role, the expiry sweep) is not restricted.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.status is distinct from old.status
     and old.status <> 'draft'
     and not public.has_community_permission(old.community_id, 'alerts.manage') then
    raise exception 'ending, cancelling or archiving a published alert requires alerts.manage'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.restrict_alert_removal() from public, anon, authenticated;

create trigger alerts_restrict_removal
  before update of status on public.alerts
  for each row execute function private.restrict_alert_removal();
