-- Structural checks: tables, RLS, constraints, foreign keys, indexes,
-- privileges, seeded reference data.
begin;
create extension if not exists pgtap with schema extensions;

select plan(86);

-- Tables --------------------------------------------------------------------
select has_table('public', t, 'table public.' || t || ' exists')
from unnest(array[
  'profiles', 'communities', 'memberships', 'roles', 'permissions',
  'membership_roles', 'role_permissions', 'role_templates', 'role_template_permissions',
  'platform_admins', 'posts', 'comments', 'reactions', 'announcements',
  'alerts', 'alert_events', 'events', 'event_rsvps', 'notifications', 'notification_types',
  'documents', 'document_folders', 'document_upload_settings', 'document_mime_types',
  'audit_logs', 'audit_actions', 'profile_private', 'invitations', 'invitation_redemptions'
]) as t;

select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity $$,
  'RLS is enabled on every public table'
);

select hasnt_column('public', 'profiles', 'email',    'profiles does not duplicate auth email');
select hasnt_column('public', 'profiles', 'password', 'profiles stores no password');
select hasnt_column('public', 'profiles', 'phone', 'phone numbers are not stored on the co-member-readable profile');

-- Unique constraints / keys --------------------------------------------------
select col_is_unique('public', 'communities', array['slug'], 'communities.slug is unique');
select col_is_unique('public', 'memberships', array['community_id', 'user_id'], 'one membership per (community, user)');
select col_is_unique('public', 'membership_roles', array['membership_id', 'role_id'], 'no duplicate role assignment');
select col_is_unique('public', 'permissions', array['key'], 'permissions.key is unique');
select col_is_pk('public', 'role_permissions', array['role_id', 'permission_id'], 'role_permissions PK(role_id, permission_id)');

-- Foreign keys and ON DELETE behaviour ---------------------------------------
-- confdeltype: a = no action, r = restrict, c = cascade, n = set null
select results_eq(
  $$ select conrelid::regclass::text, conname::text collate "default", confrelid::regclass::text, confdeltype::text
     from pg_constraint
     where contype = 'f' and connamespace = 'public'::regnamespace
     order by 1, 2 $$,
  $$ values
     ('addresses', 'addresses_user_id_fkey', 'profiles', 'c'),
     ('alert_events', 'alert_events_actor_user_id_fkey', 'profiles', 'n'),
     ('alert_events', 'alert_events_alert_id_fkey', 'alerts', 'c'),
     ('alert_events', 'alert_events_community_id_fkey', 'communities', 'r'),
     ('alerts', 'alerts_cancelled_by_fkey', 'profiles', 'n'),
     ('alerts', 'alerts_community_id_fkey', 'communities', 'r'),
     ('alerts', 'alerts_created_by_fkey', 'profiles', 'n'),
     ('alerts', 'alerts_published_by_fkey', 'profiles', 'n'),
     ('alerts', 'alerts_updated_by_user_id_fkey', 'profiles', 'n'),
     ('announcements', 'announcements_author_user_id_fkey', 'profiles', 'n'),
     ('announcements', 'announcements_community_id_fkey', 'communities', 'r'),
     ('announcements', 'announcements_updated_by_user_id_fkey', 'profiles', 'n'),
     ('audit_logs', 'audit_logs_action_fkey', 'audit_actions', 'r'),
     ('booking_events', 'booking_events_actor_user_id_fkey', 'profiles', 'n'),
     ('booking_events', 'booking_events_booking_id_fkey', 'bookings', 'r'),
     ('bookings', 'bookings_buyer_user_id_fkey', 'profiles', 'n'),
     ('bookings', 'bookings_community_id_fkey', 'communities', 'r'),
     ('bookings', 'bookings_listing_id_fkey', 'listings', 'n'),
     ('bookings', 'bookings_seller_profile_id_fkey', 'seller_profiles', 'r'),
     ('bookings', 'bookings_seller_user_id_fkey', 'profiles', 'n'),
     ('cart_items', 'cart_items_cart_fkey', 'carts', 'c'),
     ('cart_items', 'cart_items_listing_fkey', 'listings', 'c'),
     ('carts', 'carts_community_id_fkey', 'communities', 'c'),
     ('carts', 'carts_user_id_fkey', 'profiles', 'c'),
     ('checkouts', 'checkouts_buyer_user_id_fkey', 'profiles', 'n'),
     ('checkouts', 'checkouts_community_id_fkey', 'communities', 'r'),
     ('comments', 'comments_author_user_id_fkey', 'profiles', 'n'),
     ('comments', 'comments_moderated_by_user_id_fkey', 'profiles', 'n'),
     ('comments', 'comments_parent_fk', 'comments', 'n'),
     ('comments', 'comments_post_fk', 'posts', 'c'),
     ('communities', 'communities_created_by_fkey', 'auth.users', 'n'),
     ('community_notification_settings', 'community_notification_settings_community_id_fkey', 'communities', 'c'),
     ('community_notification_settings', 'community_notification_settings_user_id_fkey', 'profiles', 'c'),
     ('delivery_options', 'delivery_options_seller_fkey', 'seller_profiles', 'c'),
     ('dispute_messages', 'dispute_messages_author_user_id_fkey', 'profiles', 'n'),
     ('dispute_messages', 'dispute_messages_dispute_id_fkey', 'disputes', 'r'),
     ('disputes', 'disputes_booking_id_fkey', 'bookings', 'r'),
     ('disputes', 'disputes_buyer_user_id_fkey', 'profiles', 'n'),
     ('disputes', 'disputes_community_id_fkey', 'communities', 'r'),
     ('disputes', 'disputes_order_id_fkey', 'orders', 'r'),
     ('disputes', 'disputes_refund_id_fkey', 'refunds', 'r'),
     ('disputes', 'disputes_resolved_by_fkey', 'profiles', 'n'),
     ('disputes', 'disputes_seller_user_id_fkey', 'profiles', 'n'),
     ('document_folders', 'document_folders_community_id_fkey', 'communities', 'r'),
     ('document_folders', 'document_folders_created_by_fkey', 'profiles', 'n'),
     ('document_folders', 'document_folders_parent_fk', 'document_folders', 'n'),
     ('documents', 'documents_community_id_fkey', 'communities', 'r'),
     ('documents', 'documents_folder_fk', 'document_folders', 'n'),
     ('documents', 'documents_mime_type_fkey', 'document_mime_types', 'r'),
     ('documents', 'documents_updated_by_user_id_fkey', 'profiles', 'n'),
     ('documents', 'documents_uploaded_by_fkey', 'profiles', 'n'),
     ('event_rsvps', 'event_rsvps_event_fk', 'events', 'c'),
     ('event_rsvps', 'event_rsvps_user_id_fkey', 'profiles', 'c'),
     ('events', 'events_cancelled_by_fkey', 'profiles', 'n'),
     ('events', 'events_community_id_fkey', 'communities', 'r'),
     ('events', 'events_created_by_fkey', 'profiles', 'n'),
     ('events', 'events_updated_by_user_id_fkey', 'profiles', 'n'),
     ('favorites', 'favorites_listing_fkey', 'listings', 'c'),
     ('favorites', 'favorites_user_id_fkey', 'profiles', 'c'),
     ('inventory', 'inventory_listing_fkey', 'listings', 'c'),
     ('inventory_movements', 'inventory_movements_actor_user_id_fkey', 'profiles', 'n'),
     ('inventory_movements', 'inventory_movements_listing_id_fkey', 'inventory', 'c'),
     ('inventory_reservations', 'inventory_reservations_checkout_id_fkey', 'checkouts', 'r'),
     ('inventory_reservations', 'inventory_reservations_listing_id_fkey', 'inventory', 'r'),
     ('invitation_redemptions', 'invitation_redemptions_community_id_fkey', 'communities', 'r'),
     ('invitation_redemptions', 'invitation_redemptions_invitation_id_fkey', 'invitations', 'c'),
     ('invitation_redemptions', 'invitation_redemptions_membership_id_fkey', 'memberships', 'n'),
     ('invitation_redemptions', 'invitation_redemptions_user_id_fkey', 'profiles', 'c'),
     ('invitations', 'invitations_community_id_fkey', 'communities', 'r'),
     ('invitations', 'invitations_created_by_fkey', 'profiles', 'n'),
     ('invitations', 'invitations_revoked_by_fkey', 'profiles', 'n'),
     ('ledger_accounts', 'ledger_accounts_community_id_fkey', 'communities', 'r'),
     ('ledger_entries', 'ledger_entries_account_id_fkey', 'ledger_accounts', 'r'),
     ('ledger_entries', 'ledger_entries_transaction_id_fkey', 'ledger_transactions', 'r'),
     ('ledger_transactions', 'ledger_transactions_community_id_fkey', 'communities', 'r'),
     ('listing_images', 'listing_images_listing_fkey', 'listings', 'c'),
     ('listings', 'listings_category_id_fkey', 'market_categories', 'r'),
     ('listings', 'listings_community_id_fkey', 'communities', 'r'),
     ('listings', 'listings_removed_by_fkey', 'profiles', 'n'),
     ('listings', 'listings_seller_profile_fkey', 'seller_profiles', 'c'),
     ('listings', 'listings_seller_user_id_fkey', 'profiles', 'c'),
     ('market_categories', 'market_categories_parent_id_fkey', 'market_categories', 'r'),
     ('membership_roles', 'membership_roles_membership_fk', 'memberships', 'c'),
     ('membership_roles', 'membership_roles_role_fk', 'roles', 'r'),
     ('memberships', 'memberships_community_id_fkey', 'communities', 'r'),
     ('memberships', 'memberships_user_id_fkey', 'auth.users', 'c'),
     ('memberships', 'memberships_user_profile_fkey', 'profiles', 'c'),
     ('notifications', 'notifications_community_id_fkey', 'communities', 'c'),
     ('notifications', 'notifications_type_fkey', 'notification_types', 'r'),
     ('notifications', 'notifications_user_id_fkey', 'profiles', 'c'),
     ('order_events', 'order_events_actor_user_id_fkey', 'profiles', 'n'),
     ('order_events', 'order_events_order_id_fkey', 'orders', 'r'),
     ('order_items', 'order_items_listing_id_fkey', 'listings', 'n'),
     ('order_items', 'order_items_order_id_fkey', 'orders', 'r'),
     ('order_pickup_codes', 'order_pickup_codes_order_id_fkey', 'orders', 'r'),
     ('order_shipments', 'order_shipments_order_id_fkey', 'orders', 'r'),
     ('orders', 'orders_buyer_user_id_fkey', 'profiles', 'n'),
     ('orders', 'orders_checkout_fkey', 'checkouts', 'r'),
     ('orders', 'orders_seller_profile_id_fkey', 'seller_profiles', 'n'),
     ('orders', 'orders_seller_user_id_fkey', 'profiles', 'n'),
     ('payment_events', 'payment_events_payment_id_fkey', 'payments', 'r'),
     ('payments', 'payments_booking_fkey', 'bookings', 'r'),
     ('payments', 'payments_checkout_id_fkey', 'checkouts', 'r'),
     ('payments', 'payments_community_id_fkey', 'communities', 'r'),
     ('payments', 'payments_payer_user_id_fkey', 'profiles', 'n'),
     ('platform_admins', 'platform_admins_granted_by_fkey', 'auth.users', 'n'),
     ('platform_admins', 'platform_admins_user_id_fkey', 'auth.users', 'c'),
     ('post_images', 'post_images_post_fkey', 'posts', 'c'),
     ('posts', 'posts_author_user_id_fkey', 'profiles', 'n'),
     ('posts', 'posts_community_id_fkey', 'communities', 'r'),
     ('posts', 'posts_moderated_by_user_id_fkey', 'profiles', 'n'),
     ('profile_private', 'profile_private_user_id_fkey', 'profiles', 'c'),
     ('profiles', 'profiles_id_fkey', 'auth.users', 'c'),
     ('reactions', 'reactions_comment_fk', 'comments', 'c'),
     ('reactions', 'reactions_post_fk', 'posts', 'c'),
     ('reactions', 'reactions_user_id_fkey', 'profiles', 'c'),
     ('refund_events', 'refund_events_actor_user_id_fkey', 'profiles', 'n'),
     ('refund_events', 'refund_events_refund_id_fkey', 'refunds', 'r'),
     ('refund_items', 'refund_items_order_item_id_fkey', 'order_items', 'r'),
     ('refund_items', 'refund_items_refund_id_fkey', 'refunds', 'r'),
     ('refund_policies', 'refund_policies_community_id_fkey', 'communities', 'c'),
     ('refund_policies', 'refund_policies_updated_by_fkey', 'profiles', 'n'),
     ('refunds', 'refunds_booking_fkey', 'bookings', 'r'),
     ('refunds', 'refunds_buyer_user_id_fkey', 'profiles', 'n'),
     ('refunds', 'refunds_community_id_fkey', 'communities', 'r'),
     ('refunds', 'refunds_decided_by_fkey', 'profiles', 'n'),
     ('refunds', 'refunds_order_id_fkey', 'orders', 'r'),
     ('refunds', 'refunds_payment_id_fkey', 'payments', 'r'),
     ('refunds', 'refunds_requested_by_fkey', 'profiles', 'n'),
     ('refunds', 'refunds_seller_user_id_fkey', 'profiles', 'n'),
     ('role_permissions', 'role_permissions_permission_id_fkey', 'permissions', 'r'),
     ('role_permissions', 'role_permissions_role_id_fkey', 'roles', 'c'),
     ('role_template_permissions', 'role_template_permissions_permission_id_fkey', 'permissions', 'r'),
     ('role_template_permissions', 'role_template_permissions_template_id_fkey', 'role_templates', 'c'),
     ('roles', 'roles_community_id_fkey', 'communities', 'r'),
     ('seller_profiles', 'seller_profiles_community_id_fkey', 'communities', 'r'),
     ('seller_profiles', 'seller_profiles_user_id_fkey', 'profiles', 'c'),
     ('service_availability', 'service_availability_seller_fkey', 'seller_profiles', 'c'),
     ('service_availability', 'service_availability_seller_profile_id_fkey', 'seller_profiles', 'c'),
     ('service_time_off', 'service_time_off_seller_profile_id_fkey', 'seller_profiles', 'c'),
     ('stories', 'stories_author_user_id_fkey', 'profiles', 'c'),
     ('stories', 'stories_community_id_fkey', 'communities', 'c'),
     ('stories', 'stories_deleted_by_fkey', 'profiles', 'n'),
     ('story_views', 'story_views_story_id_fkey', 'stories', 'c'),
     ('story_views', 'story_views_viewer_user_id_fkey', 'profiles', 'c') $$,
  'foreign keys exist with the intended ON DELETE behaviour'
);

-- Indexes (each required access pattern is served by an index whose
-- leading column(s) match) -----------------------------------------------------
select ok(exists (
  select 1 from pg_index i
  where i.indrelid = format('public.%I', t.tbl)::regclass
    and (select array_agg(a.attname::text order by k.ord)
         from unnest(i.indkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         where k.ord <= cardinality(t.cols)) = t.cols
), format('index leads with %s(%s)', t.tbl, array_to_string(t.cols, ', ')))
from (values
  ('communities',      array['slug']),
  ('memberships',      array['community_id']),
  ('memberships',      array['user_id']),
  ('memberships',      array['community_id', 'status']),
  ('roles',            array['community_id']),
  ('membership_roles', array['membership_id']),
  ('membership_roles', array['role_id']),
  ('role_permissions', array['role_id']),
  ('posts',            array['community_id', 'created_at', 'id']),
  ('comments',         array['post_id', 'created_at', 'id']),
  ('comments',         array['parent_comment_id', 'created_at', 'id']),
  ('reactions',        array['post_id', 'user_id']),
  ('reactions',        array['comment_id', 'user_id']),
  ('reactions',        array['user_id']),
  ('announcements',    array['community_id', 'status', 'published_at']),
  ('announcements',    array['community_id', 'expires_at']),
  ('alerts',           array['community_id', 'status', 'published_at']),
  ('alerts',           array['expires_at']),
  ('alert_events',     array['alert_id', 'occurred_at']),
  ('events',           array['community_id', 'starts_at']),
  ('events',           array['community_id', 'status', 'starts_at']),
  ('event_rsvps',      array['event_id']),
  ('event_rsvps',      array['user_id']),
  ('notifications',    array['user_id', 'created_at']),
  ('notifications',    array['user_id', 'read_at']),
  ('notifications',    array['community_id', 'created_at']),
  ('documents',        array['community_id', 'status', 'created_at']),
  ('documents',        array['folder_id', 'created_at']),
  ('documents',        array['storage_path']),
  ('audit_logs',       array['community_id', 'created_at']),
  ('audit_logs',       array['actor_user_id', 'created_at']),
  ('audit_logs',       array['entity_type', 'entity_id']),
  ('invitations',      array['token_hash']),
  ('invitations',      array['community_id', 'created_at']),
  ('invitation_redemptions', array['invitation_id', 'user_id'])
) as t(tbl, cols);

-- Privileges -----------------------------------------------------------------
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and (has_table_privilege('anon', c.oid, 'select')
         or has_table_privilege('anon', c.oid, 'insert')
         or has_table_privilege('anon', c.oid, 'update')
         or has_table_privilege('anon', c.oid, 'delete')) $$,
  'anon has no privileges on any public table'
);

select ok(not has_table_privilege('authenticated', 'public.communities', 'insert'), 'clients cannot insert communities directly');
select ok(not has_table_privilege('authenticated', 'public.memberships', 'insert'), 'clients cannot insert memberships directly');
select ok(not has_column_privilege('authenticated', 'public.communities', 'status', 'update'), 'clients cannot change community status');
select ok(not has_column_privilege('authenticated', 'public.roles', 'is_system_role', 'insert'), 'clients cannot create system roles');
select ok(not has_function_privilege('anon', 'public.create_community(text, text, text, text, text)', 'execute'), 'anon cannot call create_community');

select is_empty(
  $$ select p.oid::regprocedure::text from pg_proc p
     where p.prosecdef
       and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
       and not coalesce(p.proconfig @> array['search_path=""'], false) $$,
  'every SECURITY DEFINER function pins search_path to empty'
);

-- Seeded permissions -----------------------------------------------------------
select results_eq(
  $$ select key from public.permissions order by key $$,
  $$ select unnest(array[
       'alerts.create', 'alerts.manage', 'alerts.view',
       'announcements.create', 'announcements.manage', 'announcements.view',
       'audit.view',
       'comments.create', 'comments.delete_own', 'comments.edit_own', 'comments.moderate',
       'community.update', 'community.view',
       'documents.manage', 'documents.upload', 'documents.view',
       'events.create', 'events.manage', 'events.view',
       'marketplace.buy', 'marketplace.manage', 'marketplace.sell', 'marketplace.view',
       'members.approve', 'members.invite', 'members.remove', 'members.suspend', 'members.view',
       'posts.create', 'posts.delete_own', 'posts.edit_own', 'posts.moderate', 'posts.view',
       'roles.manage', 'roles.view'
     ]) order by 1 $$,
  'exactly the 35 permissions are seeded (31 from Stage 1, 4 marketplace)'
);

select throws_ok(
  $$ insert into public.permissions (key, module, description) values ('community.view', 'community', 'dup') $$,
  '23505', null, 'duplicate permission keys are rejected'
);

-- Role templates -------------------------------------------------------------
select results_eq(
  $$ select t.key, count(tp.permission_id)::int
     from public.role_templates t
     left join public.role_template_permissions tp on tp.template_id = t.id
     group by t.key, t.sort_order order by t.sort_order $$,
  $$ values ('owner', 35), ('admin', 34), ('moderator', 21), ('member', 18) $$,
  'default role templates carry the documented number of permissions'
);

select is(
  (select key from public.role_templates where assign_to_creator),
  'owner', 'the Owner template is the one granted to community creators'
);

select is_empty(
  $$ select lower_t.key || ' not within ' || upper_t.key
     from (values ('member', 'moderator'), ('moderator', 'admin'), ('admin', 'owner')) as v(lo, hi)
     join public.role_templates lower_t on lower_t.key = v.lo
     join public.role_templates upper_t on upper_t.key = v.hi
     where exists (
       select permission_id from public.role_template_permissions where template_id = lower_t.id
       except
       select permission_id from public.role_template_permissions where template_id = upper_t.id
     ) $$,
  'templates nest: Member < Moderator < Admin < Owner'
);

select * from finish();
rollback;
