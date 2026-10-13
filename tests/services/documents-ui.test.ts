// What the mobile documents screens rely on (RN-13), against the real local
// Supabase: the step-by-step upload (reserve → send → complete) with a
// pluggable transport, cancel and retry, upload rules, and that the path,
// community and file identity always come from the server.
//
//   A: owner (Owner), uploader (Member + custom "Uploader": documents.upload), viewer (Member)
//   B: other (Owner)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices, ErrorCode, UploadError, type FileUploader } from '../../services/index.ts';
import { addMember, admin, cleanupCommunityContent, community, rejects, users, type TestUser } from './setup.ts';

let u: Record<'owner' | 'uploader' | 'viewer' | 'other', TestUser>;
const c: Record<string, string> = {};
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF`);
const status = async (id: string) => (await admin.from('documents').select('status').eq('id', id).single()).data?.status;
const stored = async (communityId: string, id: string) => {
  const { data } = await admin.storage.from('documents').list(`communities/${communityId}/documents/${id}`);
  return (data ?? []).map((f) => f.name);
};

before(async () => {
  u = await users('owner', 'uploader', 'viewer', 'other');
  c.A = await community(u.owner, 'DocsUiA');
  c.B = await community(u.other, 'DocsUiB');
  await addMember(c.A, u.viewer.id, 'Member');
  const membership = await addMember(c.A, u.uploader.id, 'Member');
  const { data: role } = await u.owner.client.from('roles').insert({ community_id: c.A, name: 'Uploader' }).select('id').single().throwOnError();
  const { data: perm } = await admin.from('permissions').select('id').eq('key', 'documents.upload').single().throwOnError();
  await u.owner.client.from('role_permissions').insert({ role_id: role!.id, permission_id: perm!.id }).throwOnError();
  // Fixture: assigned with the admin client (the typed insert needs community_id, which clients may not set).
  await admin.from('membership_roles').insert({ community_id: c.A, membership_id: membership, role_id: role!.id }).throwOnError();
});
after(() => cleanupCommunityContent(Object.values(c)));

describe('upload rules', () => {
  test('the size limit and the allowed types come from the server', async () => {
    const rules = await u.viewer.services.documents.uploadRules();
    assert.equal(rules.maxFileSize, 25 * 1024 * 1024);
    const exts = rules.types.map((t) => t.extension);
    assert.ok(exts.includes('pdf') && exts.includes('docx'));
    assert.ok(!exts.includes('html') && !exts.includes('svg'));
  });
});

describe('step-by-step upload', () => {
  test('reserve, send with progress, complete; the path is the server’s', async () => {
    const s = u.uploader.services.documents;
    const file = pdf('minutes');
    const pending = await s.beginUpload({ communityId: c.A, name: 'Minutes.pdf', mimeType: 'application/pdf', size: file.byteLength });
    // Pending uploads are invisible to members.
    await rejects(u.viewer.services.documents.get(pending.documentId), ErrorCode.NotFound);
    const progress: number[] = [];
    await s.sendFile(pending.documentId, file, { onProgress: (sent, total) => progress.push(sent / total) });
    assert.deepEqual(progress, [0, 1]);
    const doc = await s.completeUpload(pending.documentId);
    assert.equal(doc.status, 'active');
    assert.equal(doc.storage_path, `communities/${c.A}/documents/${doc.id}/file.pdf`);
    assert.equal(doc.file_size, file.byteLength);
    const url = await u.viewer.services.documents.getDownloadUrl(doc.id, 60);
    assert.match(await (await fetch(url)).text(), /minutes/);
  });

  test('a custom transport only ever gets the reserved path, never one from the caller', async () => {
    const seen: string[] = [];
    const base = u.uploader.client;
    const transport: FileUploader = async (r) => {
      seen.push(`${r.bucket}/${r.path}/${r.contentType}`);
      const { error } = await base.storage.from(r.bucket).upload(r.path, r.body, { contentType: r.contentType, upsert: false });
      if (error) throw new UploadError(error.message, 400);
    };
    const s = createServices(base, { uploadFile: transport }).documents;
    const file = pdf('agenda');
    const pending = await s.beginUpload({ communityId: c.A, name: 'agenda.exe', mimeType: 'application/pdf', size: file.byteLength });
    await s.sendFile(pending.documentId, file);
    assert.deepEqual(seen, [`documents/communities/${c.A}/documents/${pending.documentId}/file.pdf/application/pdf`]);
    const doc = await s.completeUpload(pending.documentId);
    assert.equal(doc.name, 'agenda.exe');
    assert.equal(doc.file_extension, 'pdf');
  });

  test('retry after a failed transfer does not duplicate; a lost answer counts as sent', async () => {
    let failNext = true;
    const base = u.uploader.client;
    const transport: FileUploader = async (r) => {
      if (failNext) {
        failNext = false;
        throw new UploadError('Network request failed', 0);
      }
      const { error } = await base.storage.from(r.bucket).upload(r.path, r.body, { contentType: r.contentType, upsert: false });
      if (error) throw new UploadError(error.message, Number((error as { statusCode?: string }).statusCode ?? 400));
    };
    const s = createServices(base, { uploadFile: transport }).documents;
    const file = pdf('budget');
    const pending = await s.beginUpload({ communityId: c.A, name: 'Budget.pdf', mimeType: 'application/pdf', size: file.byteLength });
    const offline = await rejects(s.sendFile(pending.documentId, file), ErrorCode.ServerError);
    assert.equal(offline.details.network, true);
    await s.sendFile(pending.documentId, file); // retry: stored
    await s.sendFile(pending.documentId, file); // again (answer "lost"): 409 → already sent
    await s.completeUpload(pending.documentId);
    const { count } = await admin.from('documents').select('id', { count: 'exact', head: true }).eq('community_id', c.A).eq('name', 'Budget.pdf');
    assert.equal(count, 1);
  });

  test('a file of another size than reserved is refused; so is a lying transport at completion', async () => {
    const s = u.uploader.services.documents;
    const pending = await s.beginUpload({ communityId: c.A, name: 'Small.pdf', mimeType: 'application/pdf', size: 10 });
    await rejects(s.sendFile(pending.documentId, pdf('a much longer file than ten bytes')), ErrorCode.Validation, 'file');
    // Completion checks what Storage recorded, not what the client declared.
    await rejects(s.completeUpload(pending.documentId), ErrorCode.NotFound);
    await s.cancelUpload(pending.documentId);
  });

  test('cancel: an aborted transfer, then the reservation and its file are discarded', async () => {
    const s = u.uploader.services.documents;
    const file = pdf('draft');
    const pending = await s.beginUpload({ communityId: c.A, name: 'Draft.pdf', mimeType: 'application/pdf', size: file.byteLength });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await rejects(s.sendFile(pending.documentId, file, { signal: controller.signal }), ErrorCode.Conflict);
    assert.equal(cancelled.details.cancelled, true);
    // Sent after all, then cancelled: the file is removed and the document closed.
    await s.sendFile(pending.documentId, file);
    assert.deepEqual(await stored(c.A, pending.documentId), ['file.pdf']);
    await s.cancelUpload(pending.documentId);
    assert.equal(await status(pending.documentId), 'deleted');
    assert.deepEqual(await stored(c.A, pending.documentId), []);
    await rejects(s.completeUpload(pending.documentId), ErrorCode.NotFound);
    await rejects(s.sendFile(pending.documentId, file), ErrorCode.NotFound);
  });
});

describe('authorization', () => {
  test('without documents.upload nothing is reserved', async () => {
    await rejects(u.viewer.services.documents.beginUpload({ communityId: c.A, name: 'x.pdf', mimeType: 'application/pdf', size: 10 }), ErrorCode.Forbidden);
    await rejects(u.other.services.documents.beginUpload({ communityId: c.A, name: 'x.pdf', mimeType: 'application/pdf', size: 10 }), ErrorCode.Forbidden);
    await rejects(u.uploader.services.documents.beginUpload({ communityId: c.A, name: 'x.pdf', mimeType: 'application/pdf', size: 10, visibility: 'managers' }), ErrorCode.Forbidden);
    await rejects(u.uploader.services.documents.beginUpload({ communityId: c.A, name: 'x.html', mimeType: 'text/html', size: 10 }), ErrorCode.Validation);
    await rejects(u.uploader.services.documents.beginUpload({ communityId: c.A, name: 'x.pdf', mimeType: 'application/pdf', size: 26 * 1024 * 1024 }), ErrorCode.Validation);
  });

  test("someone else's reservation cannot be sent to, completed or cancelled", async () => {
    const file = pdf('owner only');
    const pending = await u.owner.services.documents.beginUpload({ communityId: c.A, name: 'Mine.pdf', mimeType: 'application/pdf', size: file.byteLength });
    await rejects(u.uploader.services.documents.sendFile(pending.documentId, file), ErrorCode.NotFound);
    await rejects(u.other.services.documents.sendFile(pending.documentId, file), ErrorCode.NotFound);
    await rejects(u.uploader.services.documents.completeUpload(pending.documentId), ErrorCode.NotFound);
    await rejects(u.other.services.documents.cancelUpload(pending.documentId), ErrorCode.NotFound);
    // Direct Storage writes to its path are refused too.
    const direct = await u.uploader.client.storage.from('documents').upload(`communities/${c.A}/documents/${pending.documentId}/file.pdf`, file, { contentType: 'application/pdf' });
    assert.ok(direct.error);
    await u.owner.services.documents.cancelUpload(pending.documentId);
  });

  test('rename and delete: own documents with documents.upload, any with documents.manage', async () => {
    const own = await u.uploader.services.documents.upload({ communityId: c.A, name: 'Own.pdf', mimeType: 'application/pdf', file: pdf('own') });
    const theirs = await u.owner.services.documents.upload({ communityId: c.A, name: 'Theirs.pdf', mimeType: 'application/pdf', file: pdf('theirs') });
    assert.equal((await u.uploader.services.documents.rename(own.id, 'Renamed.pdf')).name, 'Renamed.pdf');
    await rejects(u.uploader.services.documents.rename(theirs.id, 'Nope.pdf'), ErrorCode.Forbidden);
    await rejects(u.viewer.services.documents.rename(own.id, 'Nope.pdf'), ErrorCode.Forbidden);
    await rejects(u.uploader.services.documents.archive(own.id), ErrorCode.Forbidden);
    await rejects(u.uploader.services.documents.delete(theirs.id), ErrorCode.Forbidden);
    assert.equal((await u.owner.services.documents.archive(theirs.id)).status, 'archived');
    await rejects(u.viewer.services.documents.getDownloadUrl(theirs.id), ErrorCode.NotFound);
    assert.equal((await u.owner.services.documents.restore(theirs.id)).status, 'active');
    await u.uploader.services.documents.delete(own.id);
    await rejects(u.viewer.services.documents.getDownloadUrl(own.id), ErrorCode.NotFound);
    await rejects(u.owner.services.documents.getDownloadUrl(own.id), ErrorCode.NotFound);
    // The file of a deleted document is unreadable even directly.
    const signed = await u.owner.client.storage.from('documents').createSignedUrl(`communities/${c.A}/documents/${own.id}/file.pdf`, 60);
    assert.ok(signed.error);
  });

  test('cross-community: another community’s documents, folders and files', async () => {
    const doc = (await u.owner.services.documents.list({ communityId: c.A })).items[0]!;
    await rejects(u.other.services.documents.get(doc.id), ErrorCode.NotFound);
    await rejects(u.other.services.documents.getDownloadUrl(doc.id), ErrorCode.NotFound);
    await rejects(u.other.services.documents.rename(doc.id, 'x.pdf'), ErrorCode.NotFound);
    assert.deepEqual((await u.other.services.documents.list({ communityId: c.A })).items, []);
    const folder = await u.owner.services.documents.createFolder({ communityId: c.A, name: 'Minutes' });
    assert.deepEqual(await u.other.services.documents.listFolders(c.A), []);
    // A folder of A cannot hold a document of B.
    await rejects(u.other.services.documents.beginUpload({ communityId: c.B, name: 'x.pdf', mimeType: 'application/pdf', size: 10, folderId: folder.id }), ErrorCode.Validation);
    const signed = await u.other.client.storage.from('documents').createSignedUrl(doc.storage_path!, 60);
    assert.ok(signed.error);
  });
});
