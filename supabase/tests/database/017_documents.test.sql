-- Stage 10: documents and file storage: metadata RLS, storage policies, paths, size/type limits, folders.
begin;
create extension if not exists pgtap with schema extensions;

select plan(75);

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

-- Helpers (created as the database owner, before any login).
-- Simulates the Storage API writing an object row as the calling user (so
-- the storage.objects RLS policies apply exactly as in production).
create function pg_temp.store_object(p_path text, p_size bigint, p_mime text) returns void language sql as $$
  insert into storage.objects (bucket_id, name, metadata)
  values ('documents', p_path, jsonb_build_object('size', p_size, 'mimetype', p_mime))
$$;
create function pg_temp.upload(p_community text, p_name text, p_mime text, p_size bigint, p_visibility text default 'members')
returns uuid language sql as $$
  select document_id from public.create_document_upload(pg_temp.fx(p_community), p_name, p_mime, p_size, null, p_visibility)
$$;
create function pg_temp.path(p_doc text) returns text language sql security definer as $$
  select storage_path from public.documents where id = pg_temp.fx(p_doc)
$$;
create temp table paths (key text primary key, path text);
grant all on paths to public;

-- Custom "Uploader" role for carol: documents.view + documents.upload (no manage).
select pg_temp.login(pg_temp.fx('alice'));
insert into public.roles (community_id, name) values (pg_temp.fx('A'), 'Uploader');
insert into public.role_permissions (role_id, permission_id)
select pg_temp.role_id('A', 'Uploader'), id from public.permissions where key in ('documents.view', 'documents.upload');
insert into public.membership_roles (membership_id, role_id) values (pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Uploader'));

-- =========================================================================
-- Upload flow
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
insert into fx select 'minutes', pg_temp.upload('A', 'Minutes March.pdf', 'application/pdf', 1000);
insert into paths select 'minutes', pg_temp.path('minutes');
select results_eq(
  $$ select status, uploaded_by, name, storage_path from public.documents where id = pg_temp.fx('minutes') $$,
  format($$ values ('pending_upload', %L::uuid, 'Minutes March.pdf', %L) $$,
         pg_temp.fx('erin'), 'communities/' || pg_temp.fx('A') || '/documents/' || pg_temp.fx('minutes') || '/file.pdf'),
  'upload metadata: pending, uploader from the session, generated storage path'
);
select lives_ok(
  format($$ select pg_temp.store_object(%L, 1000, 'application/pdf') $$, pg_temp.path('minutes')),
  'the uploader stores the file at exactly the issued path'
);
select results_eq(
  format($$ select status, file_size from public.complete_document_upload(%L) $$, pg_temp.fx('minutes')),
  $$ values ('active', 1000::bigint) $$,
  'completing the upload verifies the stored object and activates the document'
);

-- Restricted (managers-only) document
insert into fx select 'budget', pg_temp.upload('A', 'Budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 2000, 'managers');
insert into paths select 'budget', pg_temp.path('budget');
select pg_temp.store_object(pg_temp.path('budget'), 2000, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
select public.complete_document_upload(pg_temp.fx('budget'));

-- =========================================================================
-- 1. Authorized member can access a permitted document
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select isnt_empty($$ select 1 from public.documents where id = pg_temp.fx('minutes') $$, '1. a member with documents.view sees a members-visible document');
select isnt_empty(
  $$ select 1 from storage.objects where bucket_id = 'documents' and name = (select path from paths where key = 'minutes') $$,
  '1. ...and the storage policy allows downloading its file'
);

-- =========================================================================
-- 2. Unauthorized member cannot access a restricted document
-- =========================================================================
select is_empty($$ select 1 from public.documents where id = pg_temp.fx('budget') $$, '2. a member cannot see a managers-only document');
select is_empty(
  $$ select 1 from storage.objects where name = (select path from paths where key = 'budget') $$,
  '2. ...nor download its file, even knowing the exact path'
);
select pg_temp.login(pg_temp.fx('alice'));
select isnt_empty($$ select 1 from storage.objects where name = (select path from paths where key = 'budget') $$, '2. managers can download restricted files');

-- =========================================================================
-- 3. No access to another community's files
-- =========================================================================
select pg_temp.login(pg_temp.fx('frank'));
select is_empty($$ select 1 from public.documents where community_id = pg_temp.fx('A') $$, '3. another community''s document metadata is invisible');
select is_empty($$ select 1 from storage.objects where bucket_id = 'documents' $$, '3. another community''s files cannot be listed or downloaded');
select is_empty(format($$ select * from public.list_documents(%L) $$, pg_temp.fx('A')), '3. ...or listed through list_documents');

-- =========================================================================
-- 4. Storage paths cannot be manipulated
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
insert into fx select 'carol_doc', pg_temp.upload('A', '../../etc/passwd.pdf', 'application/pdf', 500);
select results_eq(
  $$ select name, right(storage_path, 9) from public.documents where id = pg_temp.fx('carol_doc') $$,
  $$ values ('passwd.pdf', '/file.pdf') $$,
  '4. path components are stripped from the display name and never reach the storage path'
);
select throws_like(
  format($$ select pg_temp.store_object(%L, 500, 'application/pdf') $$, 'communities/' || pg_temp.fx('B') || '/documents/' || pg_temp.fx('carol_doc') || '/file.pdf'),
  '%row-level security%', '4. a file cannot be written into another community''s path'
);
select throws_like(
  format($$ select pg_temp.store_object(%L, 500, 'application/pdf') $$, pg_temp.path('carol_doc') || '/../../../' || pg_temp.fx('minutes') || '/file.pdf'),
  '%row-level security%', '4. path traversal segments do not match any issued path'
);
select throws_like(
  $$ select pg_temp.store_object('evil.pdf', 500, 'application/pdf') $$,
  '%row-level security%', '4. arbitrary object names are refused'
);
select throws_like(
  format($$ select pg_temp.store_object(%L, 500, 'application/pdf') $$, pg_temp.path('minutes')),
  '%row-level security%', '4. a file cannot be written to another document''s path (no replacement)'
);
with u as (update storage.objects set metadata = '{"size": 1}' where bucket_id = 'documents' returning 1)
select is(count(*)::int, 0, '4. stored files can never be modified or replaced (no UPDATE policy)') from u;
select throws_ok(
  format($$ update public.documents set storage_path = 'communities/x/evil' where id = %L $$, pg_temp.fx('carol_doc')),
  null, null, '4. storage_path cannot be set by clients'
);
select throws_ok(
  format($$ insert into public.documents (community_id, uploaded_by, name, mime_type, file_extension, file_size) values (%L, %L, 'x', 'application/pdf', 'pdf', 1) $$,
         pg_temp.fx('A'), pg_temp.fx('carol')),
  '42501', null, '4. clients cannot insert document metadata directly'
);
select throws_ok(
  format($$ select * from public.create_document_upload(%L, '..', 'application/pdf', 10) $$, pg_temp.fx('A')),
  '22023', null, '4. dot-only names are rejected'
);
insert into fx select 'exe', pg_temp.upload('A', 'invoice.exe', 'application/pdf', 10);
select ok(
  (select storage_path like '%/file.pdf' from public.documents where id = pg_temp.fx('exe')),
  '4. the stored extension comes from the validated MIME type, not the file name'
);
select pg_temp.store_object(pg_temp.path('exe'), 10, 'application/pdf');
select public.complete_document_upload(pg_temp.fx('exe'));

-- The storage INSERT policy requires a PENDING document AND a current
-- documents.upload permission, not just authorship.
insert into fx select 'cancelled', pg_temp.upload('A', 'cancelled.pdf', 'application/pdf', 10);
update public.documents set status = 'deleted' where id = pg_temp.fx('cancelled');
select throws_like(
  format($$ select pg_temp.store_object(%L, 10, 'application/pdf') $$, pg_temp.path('cancelled')),
  '%row-level security%', '4. a file cannot be uploaded to the path of a cancelled (deleted) document'
);
insert into fx select 'revoked', pg_temp.upload('A', 'revoked.pdf', 'application/pdf', 10);
reset role;
delete from public.membership_roles where membership_id = pg_temp.fx('carol@A') and role_id = pg_temp.role_id('A', 'Uploader');
select pg_temp.login(pg_temp.fx('carol'));
select throws_like(
  format($$ select pg_temp.store_object(%L, 10, 'application/pdf') $$, pg_temp.path('revoked')),
  '%row-level security%', '6. after losing documents.upload, a user cannot upload even to her own pending path'
);
reset role;
insert into public.membership_roles (membership_id, role_id) values (pg_temp.fx('carol@A'), pg_temp.role_id('A', 'Uploader'));
select pg_temp.login(pg_temp.fx('carol'));

-- =========================================================================
-- 6. Unauthorized upload / 7. file size and type restrictions
-- =========================================================================
select pg_temp.login(pg_temp.fx('dave'));
select throws_ok(
  format($$ select * from public.create_document_upload(%L, 'x.pdf', 'application/pdf', 10) $$, pg_temp.fx('A')),
  '42501', null, '6. a member without documents.upload cannot upload'
);
select pg_temp.login(pg_temp.fx('grace'));
select throws_ok(
  format($$ select * from public.create_document_upload(%L, 'x.pdf', 'application/pdf', 10) $$, pg_temp.fx('A')),
  '42501', null, '6. a pending member cannot upload'
);
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(
  format($$ select * from public.create_document_upload(%L, 'x.pdf', 'application/pdf', 10, null, 'managers') $$, pg_temp.fx('A')),
  '42501', null, '6. restricted documents require documents.manage'
);
select throws_like(
  format($$ select * from public.create_document_upload(%L, 'page.html', 'text/html', 10) $$, pg_temp.fx('A')),
  '%not allowed%', '7. active content types (HTML) are refused'
);
select throws_like(
  format($$ select * from public.create_document_upload(%L, 'logo.svg', 'image/svg+xml', 10) $$, pg_temp.fx('A')),
  '%not allowed%', '7. SVG is refused'
);
select throws_like(
  format($$ select * from public.create_document_upload(%L, 'empty.pdf', 'application/pdf', 0) $$, pg_temp.fx('A')),
  '%file size must be between%', '7. empty files are refused'
);
select throws_like(
  format($$ select * from public.create_document_upload(%L, 'huge.pdf', 'application/pdf', 26214401) $$, pg_temp.fx('A')),
  '%file size must be between%', '7. files over the configured limit are refused'
);
select throws_like(
  format($$ select * from public.complete_document_upload(%L) $$, pg_temp.fx('carol_doc')),
  '%has not been uploaded%', '7. an upload cannot be completed before the file exists'
);
select pg_temp.store_object(pg_temp.path('carol_doc'), 99999999, 'application/pdf');
select throws_like(
  format($$ select * from public.complete_document_upload(%L) $$, pg_temp.fx('carol_doc')),
  '%outside the allowed range%', '7. the size Storage recorded is checked, not the size the client declared'
);
insert into fx select 'png', pg_temp.upload('A', 'photo.png', 'image/png', 300);
select pg_temp.store_object(pg_temp.path('png'), 300, 'text/html');
select throws_like(
  format($$ select * from public.complete_document_upload(%L) $$, pg_temp.fx('png')),
  '%does not match%', '7. the content type Storage recorded must match the declared type'
);
reset role;
set local role service_role;
update public.document_upload_settings set max_file_size_bytes = 400;
reset role;
select pg_temp.login(pg_temp.fx('carol'));
select throws_like(
  format($$ select * from public.create_document_upload(%L, 'mid.pdf', 'application/pdf', 450) $$, pg_temp.fx('A')),
  '%between 1 and 400 bytes%', '7. the limit is configurable'
);
select throws_ok(
  $$ update public.document_upload_settings set max_file_size_bytes = 1 $$,
  '42501', null, '7. clients cannot change the limit'
);
reset role;
select throws_ok(
  $$ update public.document_upload_settings set max_file_size_bytes = 104857600 $$,
  '23514', null, '7. the configurable limit cannot exceed the bucket ceiling'
);
update public.document_upload_settings set max_file_size_bytes = 26214400;

-- =========================================================================
-- 8. Metadata cannot claim another community or owner
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
select throws_ok(
  format($$ select * from public.create_document_upload(%L, 'x.pdf', 'application/pdf', 10) $$, pg_temp.fx('B')),
  '42501', null, '8. a document cannot be created in another community'
);
select throws_ok(
  format($$ update public.documents set community_id = %L where id = %L $$, pg_temp.fx('B'), pg_temp.fx('exe')),
  '42501', null, '8. a document cannot be moved to another community'
);
select throws_ok(
  format($$ update public.documents set uploaded_by = %L where id = %L $$, pg_temp.fx('erin'), pg_temp.fx('exe')),
  '42501', null, '8. uploader cannot be forged'
);
select pg_temp.login(pg_temp.fx('bob'));
with i as (insert into public.document_folders (community_id, name) values (pg_temp.fx('B'), 'B folder') returning id)
insert into fx select 'folder_b', id from i;
select pg_temp.login(pg_temp.fx('erin'));
select throws_like(
  format($$ select * from public.create_document_upload(%L, 'x.pdf', 'application/pdf', 10, %L) $$, pg_temp.fx('A'), pg_temp.fx('folder_b')),
  '%folder not found in this community%', '8. a document cannot be filed in another community''s folder'
);

-- =========================================================================
-- Rename / move / folders
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
with u as (update public.documents set name = 'Hijacked.pdf' where id = pg_temp.fx('minutes') returning 1)
select is(count(*)::int, 0, 'a user cannot rename another user''s document') from u;
update public.documents set name = '  sub/dir/Notes.pdf ' where id = pg_temp.fx('exe');
select is((select name from public.documents where id = pg_temp.fx('exe')), 'Notes.pdf', 'the uploader renames her document; names are sanitised');
select throws_like(
  format($$ insert into public.document_folders (community_id, name) values (%L, 'Mine') $$, pg_temp.fx('A')),
  '%row-level security%', 'folders require documents.manage'
);
select pg_temp.login(pg_temp.fx('erin'));
with i as (insert into public.document_folders (community_id, name) values (pg_temp.fx('A'), 'Board') returning id)
insert into fx select 'folder', id from i;
with i as (insert into public.document_folders (community_id, parent_folder_id, name) values (pg_temp.fx('A'), pg_temp.fx('folder'), '2026') returning id)
insert into fx select 'subfolder', id from i;
select throws_like(
  format($$ update public.document_folders set parent_folder_id = %L where id = %L $$, pg_temp.fx('subfolder'), pg_temp.fx('folder')),
  '%inside itself%', 'folders cannot be moved inside themselves'
);
select throws_ok(
  format($$ update public.document_folders set parent_folder_id = %L where id = %L $$, pg_temp.fx('folder_b'), pg_temp.fx('folder')),
  null, null, 'a folder cannot be nested under another community''s folder'
);
update public.documents set folder_id = pg_temp.fx('subfolder') where id = pg_temp.fx('minutes');
select is((select folder_id from public.documents where id = pg_temp.fx('minutes')), pg_temp.fx('subfolder'), 'a manager moves a document into a folder');
select throws_ok(
  format($$ update public.documents set folder_id = %L where id = %L $$, pg_temp.fx('folder_b'), pg_temp.fx('minutes')),
  '23503', null, '8. a document cannot be moved into another community''s folder'
);

-- =========================================================================
-- 5. Unauthorized deletion / 10. archived and deleted documents
-- =========================================================================
select pg_temp.login(pg_temp.fx('carol'));
with u as (update public.documents set status = 'deleted' where id = pg_temp.fx('minutes') returning 1)
select is(count(*)::int, 0, '5. a user cannot delete another user''s document') from u;
select ok(not private.can_delete_document_object('documents', pg_temp.path('minutes')), '5. the storage policy refuses to delete another user''s file');
select pg_temp.login(pg_temp.fx('dave'));
select ok(not private.can_delete_document_object('documents', pg_temp.path('minutes')), '5. a viewer cannot delete files');
select pg_temp.login(pg_temp.fx('erin'));
select ok(not private.can_delete_document_object('documents', pg_temp.path('minutes')), '5. even a manager cannot remove the file of an ACTIVE document');

update public.documents set status = 'archived' where id = pg_temp.fx('minutes');
select pg_temp.login(pg_temp.fx('dave'));
select is_empty($$ select 1 from public.documents where id = pg_temp.fx('minutes') $$, '10. archived documents are hidden from members');
select is_empty($$ select 1 from storage.objects where name = (select path from paths where key = 'minutes') $$, '10. ...and their files cannot be downloaded by members');
select pg_temp.login(pg_temp.fx('alice'));
select isnt_empty($$ select 1 from storage.objects where name = (select path from paths where key = 'minutes') $$, '10. managers can still download archived files');
select pg_temp.login(pg_temp.fx('erin'));
update public.documents set status = 'active' where id = pg_temp.fx('minutes');
select pg_temp.login(pg_temp.fx('dave'));
select isnt_empty($$ select 1 from public.documents where id = pg_temp.fx('minutes') $$, '10. restoring an archived document makes it visible again');

select pg_temp.login(pg_temp.fx('carol'));
select throws_like(
  format($$ update public.documents set status = 'archived' where id = %L $$, pg_temp.fx('exe')),
  '%requires documents.manage%', '10. archiving requires documents.manage'
);
update public.documents set status = 'deleted' where id = pg_temp.fx('exe');
select is((select status from public.documents where id = pg_temp.fx('exe')), 'deleted', '10. the uploader soft-deletes her document');
select throws_like(
  format($$ update public.documents set status = 'active' where id = %L $$, pg_temp.fx('exe')),
  '%deleted documents cannot be modified%', '10. deleted is terminal'
);
select pg_temp.login(pg_temp.fx('dave'));
select is_empty($$ select 1 from public.documents where id = pg_temp.fx('exe') $$, '10. deleted documents are invisible to members');
select pg_temp.login(pg_temp.fx('carol'));
select ok(not private.can_delete_document_object('documents', pg_temp.path('exe')), '10. clients do not remove deleted documents'' files (the purge job does)');
select ok(private.can_delete_document_object('documents', pg_temp.path('png')), '10. an uploader may discard her own abandoned pending upload');
select throws_ok($$ select * from public.list_document_files_to_purge() $$, '42501', null, '10. clients cannot run the purge listing');
reset role;
set local role service_role;
select results_eq(
  format($$ select status from public.list_document_files_to_purge(interval '0 seconds') where document_id = %L $$, pg_temp.fx('exe')),
  $$ values ('deleted') $$,
  '10. the service-role purge job finds the deleted document''s file'
);
reset role;
select pg_temp.login(pg_temp.fx('carol'));

-- Deleting a folder moves its documents to the top level.
select pg_temp.login(pg_temp.fx('erin'));
delete from public.document_folders where id = pg_temp.fx('folder');
select results_eq(
  $$ select (select folder_id from public.documents where id = pg_temp.fx('minutes')),
            (select parent_folder_id from public.document_folders where id = pg_temp.fx('subfolder')) $$,
  $$ values (pg_temp.fx('subfolder'), null::uuid) $$,
  'deleting a folder moves its subfolders to the top level'
);

-- =========================================================================
-- 9. Storage policy matches database authorization (every user × every file)
-- =========================================================================
insert into paths select 'carol_doc', pg_temp.path('carol_doc');
insert into paths select 'exe', pg_temp.path('exe');
create function pg_temp.storage_matches_metadata() returns boolean language sql as $$
  select
    coalesce((select array_agg(d.storage_path order by d.storage_path) from public.documents d
              where d.storage_path in (select path from paths) and d.status in ('active', 'archived', 'pending_upload')), '{}')
    =
    coalesce((select array_agg(o.name order by o.name) from storage.objects o
              where o.bucket_id = 'documents' and o.name in (select path from paths)), '{}')
$$;
select pg_temp.login(pg_temp.fx('alice'));
select ok(pg_temp.storage_matches_metadata(), '9. Owner: downloadable files = visible documents');
select pg_temp.login(pg_temp.fx('erin'));
select ok(pg_temp.storage_matches_metadata(), '9. Admin: downloadable files = visible documents');
select pg_temp.login(pg_temp.fx('dave'));
select ok(pg_temp.storage_matches_metadata(), '9. Moderator (view only): downloadable files = visible documents');
select pg_temp.login(pg_temp.fx('carol'));
select ok(pg_temp.storage_matches_metadata(), '9. Uploader: downloadable files = visible documents');
select pg_temp.login(pg_temp.fx('frank'));
select ok(pg_temp.storage_matches_metadata(), '9. other community: downloadable files = visible documents (none)');
select pg_temp.login(pg_temp.fx('grace'));
select ok(pg_temp.storage_matches_metadata(), '9. pending member: downloadable files = visible documents (none)');

-- Suspended members lose file access immediately.
reset role;
update public.memberships set status = 'suspended' where id = pg_temp.fx('dave@A');
select pg_temp.login(pg_temp.fx('dave'));
select is_empty($$ select 1 from storage.objects where bucket_id = 'documents' $$, 'a suspended member can no longer download files');

-- =========================================================================
-- Listing and pagination
-- =========================================================================
select pg_temp.login(pg_temp.fx('erin'));
create temp table bulk_docs (id uuid, path text);
grant all on bulk_docs to public;
insert into bulk_docs select u.document_id, u.storage_path
from generate_series(1, 12) as i,
     lateral public.create_document_upload(pg_temp.fx('A'), 'Note ' || i || '.txt', 'text/plain', 100) as u;
select pg_temp.store_object(path, 100, 'text/plain') from bulk_docs;
select count(public.complete_document_upload(id)) from bulk_docs;
create temp table dpages (page int, id uuid);
grant all on dpages to public;
do $$
declare v_at timestamptz; v_id uuid; v_page int := 0; v_n int;
begin
  loop
    v_page := v_page + 1;
    insert into dpages select v_page, d.id from public.list_documents(pg_temp.fx('A'), p_limit => 5, p_cursor_created_at => v_at, p_cursor_id => v_id) d;
    get diagnostics v_n = row_count;
    exit when v_n < 5 or v_page > 10;
    select d.created_at, d.id into v_at, v_id
    from public.list_documents(pg_temp.fx('A'), p_limit => 5, p_cursor_created_at => v_at, p_cursor_id => v_id) d
    order by d.created_at, d.id limit 1;
  end loop;
end;
$$;
select is(
  (select count(distinct id)::int from dpages),
  (select count(*)::int from public.documents where community_id = pg_temp.fx('A') and status = 'active'),
  'documents paginate: every active document exactly once'
);
select ok((select max(c) from (select count(*) c from dpages group by page) x) <= 5, 'pages respect the limit');

reset role;
set local role anon;
select throws_ok($$ select * from public.documents $$, '42501', null, 'anon cannot read document metadata');
select is_empty($$ select 1 from storage.objects where bucket_id = 'documents' $$, 'anon cannot see any stored file');

select * from finish();
rollback;
