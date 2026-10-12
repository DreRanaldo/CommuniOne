// Stage 10: documents through the real Data API AND the real Storage API
// (uploads, signed-URL downloads and deletes go through Supabase Storage,
// whose access is decided by our storage.objects policies).
//
//   Community A                                  Community B
//     ownerA   Owner (documents.view/upload/manage)  ownerB  Owner
//     uploader Member + documents.upload
//     viewer   Member (documents.view)
//
// Blocks run in order and share state.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addMember, admin, createConfirmedUser, deleteTrackedUsers, roleId, signIn, trackCommunity } from './helpers.mjs';

const BUCKET = 'documents';
const u = {};
const c = {};
const d = {};

after(async () => {
  await admin.from('document_upload_settings').update({ max_file_size_bytes: 26214400 }).eq('id', true);
  const { data: docs } = await admin.from('documents').select('storage_path').in('community_id', Object.values(c));
  if (docs?.length) await admin.storage.from(BUCKET).remove(docs.map((x) => x.storage_path));
  for (const id of Object.values(c)) {
    await admin.from('documents').delete().eq('community_id', id);
    await admin.from('document_folders').delete().eq('community_id', id);
  }
  await deleteTrackedUsers();
});

const pdf = (text) => new Blob([`%PDF-1.4\n${text}\n%%EOF`], { type: 'application/pdf' });

// Full client flow: metadata → Storage upload → completion.
async function uploadDocument(user, communityId, name, blob, extra = {}) {
  const { data: rows, error } = await user.client.rpc('create_document_upload', {
    p_community_id: communityId, p_name: name, p_mime_type: blob.type, p_file_size: blob.size, ...extra,
  });
  if (error) return { error };
  const { document_id: id, storage_path: path } = rows[0];
  const up = await user.client.storage.from(BUCKET).upload(path, blob, { contentType: blob.type });
  if (up.error) return { error: up.error, id, path };
  const done = await user.client.rpc('complete_document_upload', { p_document_id: id });
  return { error: done.error, id, path, doc: done.data };
}

async function download(user, path) {
  const { data, error } = await user.client.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error) return { error };
  const response = await fetch(data.signedUrl);
  return { status: response.status, text: await response.text() };
}

before(async () => {
  for (const name of ['ownerA', 'uploader', 'viewer', 'ownerB']) {
    const user = await createConfirmedUser(name.toLowerCase());
    u[name] = { ...user, client: (await signIn(user.email)).client };
  }
  for (const [key, owner] of [['A', u.ownerA], ['B', u.ownerB]]) {
    const { data, error } = await owner.client.rpc('create_community', {
      p_name: `Docs ${key}`, p_slug: `docs-${key.toLowerCase()}-${owner.id.slice(0, 8)}`,
    });
    if (error) throw error;
    trackCommunity(data.id);
    c[key] = data.id;
  }
  await addMember(c.A, u.viewer.id, 'Member');
  const uploaderMembership = await addMember(c.A, u.uploader.id, 'Member');
  await u.ownerA.client.from('roles').insert({ community_id: c.A, name: 'Uploader' }).throwOnError();
  const role = await roleId(c.A, 'Uploader');
  const { data: perm } = await admin.from('permissions').select('id').eq('key', 'documents.upload').single();
  await u.ownerA.client.from('role_permissions').insert({ role_id: role, permission_id: perm.id }).throwOnError();
  await u.ownerA.client.from('membership_roles').insert({ membership_id: uploaderMembership, role_id: role }).throwOnError();
});

describe('upload and download', () => {
  test('an authorized member uploads a document through Storage', async () => {
    const r = await uploadDocument(u.uploader, c.A, 'Pool rules.pdf', pdf('pool rules'));
    assert.equal(r.error, null);
    assert.equal(r.doc.status, 'active');
    assert.equal(r.path, `communities/${c.A}/documents/${r.id}/file.pdf`);
    d.rules = r;
  });

  test('1. a member with documents.view downloads it via a signed URL', async () => {
    const r = await download(u.viewer, d.rules.path);
    assert.equal(r.status, 200);
    assert.match(r.text, /pool rules/);
  });

  test('the bucket is private: no public URL access', async () => {
    const { data } = admin.storage.from(BUCKET).getPublicUrl(d.rules.path);
    const response = await fetch(data.publicUrl);
    assert.notEqual(response.status, 200);
  });

  test('2. a restricted document cannot be accessed by a regular member', async () => {
    const r = await uploadDocument(u.ownerA, c.A, 'Board budget.pdf', pdf('secret budget'), { p_visibility: 'managers' });
    assert.equal(r.error, null);
    d.budget = r;
    assert.ok((await download(u.viewer, d.budget.path)).error, 'viewer cannot get a signed URL');
    assert.deepEqual((await u.viewer.client.from('documents').select('id').eq('id', d.budget.id)).data, []);
    assert.equal((await download(u.ownerA, d.budget.path)).status, 200, 'managers can');
  });

  test('3. another community cannot access the files', async () => {
    assert.ok((await download(u.ownerB, d.rules.path)).error);
    const { data } = await u.ownerB.client.storage.from(BUCKET).list(`communities/${c.A}/documents`);
    assert.deepEqual(data ?? [], []);
    assert.deepEqual((await u.ownerB.client.from('documents').select('id').eq('community_id', c.A)).data, []);
  });
});

describe('attacks on paths, ownership and limits', () => {
  test('6. a member without documents.upload cannot upload', async () => {
    const r = await uploadDocument(u.viewer, c.A, 'x.pdf', pdf('x'));
    assert.equal(r.error?.code, '42501');
  });

  test('8. metadata cannot claim another community', async () => {
    const r = await uploadDocument(u.uploader, c.B, 'x.pdf', pdf('x'));
    assert.equal(r.error?.code, '42501');
  });

  test('4. a file cannot be uploaded outside the issued path', async () => {
    const { data: rows } = await u.uploader.client.rpc('create_document_upload', {
      p_community_id: c.A, p_name: 'notes.pdf', p_mime_type: 'application/pdf', p_file_size: 50,
    });
    const { document_id: id } = rows[0];
    for (const path of [
      `communities/${c.B}/documents/${id}/file.pdf`,
      `communities/${c.A}/documents/${id}/../../${d.budget.id}/file.pdf`,
      `communities/${c.A}/documents/${id}/other.pdf`,
      'anywhere.pdf',
    ]) {
      const { error } = await u.uploader.client.storage.from(BUCKET).upload(path, pdf('evil'), { contentType: 'application/pdf' });
      assert.ok(error, `upload to ${path} must fail`);
    }
  });

  test('4. an existing file cannot be overwritten (no upsert / replacement)', async () => {
    const { error } = await u.ownerA.client.storage.from(BUCKET)
      .upload(d.rules.path, pdf('replaced!'), { contentType: 'application/pdf', upsert: true });
    assert.ok(error);
    assert.match((await download(u.viewer, d.rules.path)).text, /pool rules/, 'content unchanged');
  });

  test('7. disallowed file types are refused by the database and by the bucket', async () => {
    const html = new Blob(['<script>alert(1)</script>'], { type: 'text/html' });
    const r = await uploadDocument(u.uploader, c.A, 'page.html', html);
    assert.equal(r.error?.code, '22023');

    // Even with an issued path, Storage refuses a content type outside the bucket allow-list.
    const { data: rows } = await u.uploader.client.rpc('create_document_upload', {
      p_community_id: c.A, p_name: 'sneaky.pdf', p_mime_type: 'application/pdf', p_file_size: 25,
    });
    const up = await u.uploader.client.storage.from(BUCKET).upload(rows[0].storage_path, html, { contentType: 'text/html' });
    assert.ok(up.error, 'bucket allow-list rejects text/html');
  });

  test('7. the configurable size limit is enforced on the stored file', async () => {
    await admin.from('document_upload_settings').update({ max_file_size_bytes: 1000 }).eq('id', true).throwOnError();
    const declaredTooBig = await u.uploader.client.rpc('create_document_upload', {
      p_community_id: c.A, p_name: 'big.pdf', p_mime_type: 'application/pdf', p_file_size: 5000,
    });
    assert.equal(declaredTooBig.error?.code, '22023');

    // Lies about the size: declares 100 bytes, uploads 3000.
    const { data: rows } = await u.uploader.client.rpc('create_document_upload', {
      p_community_id: c.A, p_name: 'liar.pdf', p_mime_type: 'application/pdf', p_file_size: 100,
    });
    const big = new Blob(['x'.repeat(3000)], { type: 'application/pdf' });
    await u.uploader.client.storage.from(BUCKET).upload(rows[0].storage_path, big, { contentType: 'application/pdf' });
    const done = await u.uploader.client.rpc('complete_document_upload', { p_document_id: rows[0].document_id });
    assert.equal(done.error?.code, '22023', 'the size recorded by Storage is what counts');
    await admin.from('document_upload_settings').update({ max_file_size_bytes: 26214400 }).eq('id', true).throwOnError();
  });
});

describe('managing, archiving and deleting', () => {
  test('rename: the uploader can, others cannot; names are sanitised', async () => {
    const { data } = await u.uploader.client.from('documents').update({ name: ' ../Pool rules 2026.pdf ' }).eq('id', d.rules.id).select('name');
    assert.deepEqual(data, [{ name: 'Pool rules 2026.pdf' }]);
    assert.deepEqual((await u.viewer.client.from('documents').update({ name: 'pwned.pdf' }).eq('id', d.rules.id).select()).data, []);
  });

  test('5. unauthorized users cannot delete documents or their files', async () => {
    assert.deepEqual((await u.viewer.client.from('documents').update({ status: 'deleted' }).eq('id', d.rules.id).select()).data, []);
    const { data: removed } = await u.viewer.client.storage.from(BUCKET).remove([d.rules.path]);
    assert.deepEqual(removed ?? [], [], 'storage removes nothing for an unauthorized user');
    const { data: activeRemoved } = await u.ownerA.client.storage.from(BUCKET).remove([d.rules.path]);
    assert.deepEqual(activeRemoved ?? [], [], 'not even a manager can remove the file of an ACTIVE document');
    assert.equal((await download(u.viewer, d.rules.path)).status, 200, 'file still there');
  });

  test('10. archived documents are hidden from members but kept for managers', async () => {
    await u.ownerA.client.from('documents').update({ status: 'archived' }).eq('id', d.rules.id).throwOnError();
    assert.ok((await download(u.viewer, d.rules.path)).error);
    assert.equal((await download(u.ownerA, d.rules.path)).status, 200);
    await u.ownerA.client.from('documents').update({ status: 'active' }).eq('id', d.rules.id).throwOnError();
    assert.equal((await download(u.viewer, d.rules.path)).status, 200, 'restored');
  });

  test('10. deleting: soft delete hides the file; the service-role purge job removes it', async () => {
    await u.uploader.client.from('documents').update({ status: 'deleted' }).eq('id', d.rules.id).throwOnError();
    assert.ok((await download(u.viewer, d.rules.path)).error, 'deleted documents cannot be downloaded');
    assert.ok((await download(u.uploader, d.rules.path)).error, '...not even by the uploader');
    const { data: clientRemoved } = await u.uploader.client.storage.from(BUCKET).remove([d.rules.path]);
    assert.deepEqual(clientRemoved ?? [], [], 'clients do not remove deleted files');
    const restore = await u.uploader.client.from('documents').update({ status: 'active' }).eq('id', d.rules.id);
    assert.equal(restore.error?.code, '42501', 'deleted is terminal');

    assert.ok((await u.uploader.client.rpc('list_document_files_to_purge')).error, 'clients cannot list purge candidates');
    const { data: candidates } = await admin.rpc('list_document_files_to_purge', { p_retention: '0 seconds' });
    const mine = candidates.find((x) => x.document_id === d.rules.id);
    assert.equal(mine?.status, 'deleted');
    const { data: purged, error } = await admin.storage.from(BUCKET).remove([mine.storage_path]);
    assert.equal(error, null);
    assert.equal(purged.length, 1, 'the purge job removes the file through the Storage API');
    await admin.from('documents').update({ file_purged_at: new Date().toISOString() }).eq('id', d.rules.id).throwOnError();
  });

  test('an uploader can discard her own abandoned pending upload', async () => {
    const { data: rows } = await u.uploader.client.rpc('create_document_upload', {
      p_community_id: c.A, p_name: 'draft.pdf', p_mime_type: 'application/pdf', p_file_size: 20,
    });
    await u.uploader.client.storage.from(BUCKET).upload(rows[0].storage_path, pdf('draft'), { contentType: 'application/pdf' }).then((r) => assert.equal(r.error, null));
    const { data: removed, error } = await u.uploader.client.storage.from(BUCKET).remove([rows[0].storage_path]);
    assert.equal(error, null);
    assert.equal(removed.length, 1);
  });

  test('folders and listing', async () => {
    const { data: folder } = await u.ownerA.client.from('document_folders').insert({ community_id: c.A, name: 'Board' }).select('id').single();
    const notAllowed = await u.uploader.client.from('document_folders').insert({ community_id: c.A, name: 'Mine' });
    assert.equal(notAllowed.error?.code, '42501', 'folders need documents.manage');
    const r = await uploadDocument(u.ownerA, c.A, 'Agenda.pdf', pdf('agenda'), { p_folder_id: folder.id });
    assert.equal(r.error, null);
    const { data: inFolder } = await u.viewer.client.rpc('list_documents', { p_community_id: c.A, p_folder_id: folder.id });
    assert.deepEqual(inFolder.map((x) => x.name), ['Agenda.pdf']);
    const { data: all } = await u.viewer.client.rpc('list_documents', { p_community_id: c.A });
    assert.ok(!all.some((x) => x.id === d.budget.id), 'restricted documents are not listed for members');
  });
});
