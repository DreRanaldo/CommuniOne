// Community documents through the whole app (REAL service layer) against a
// fake Supabase applying the Stage 10 rules: metadata RLS (members /
// managers-only / archived / pending / deleted), the write trigger (rename,
// archive, delete), the upload RPCs (allow-list, size, folder, server-made
// path, completion checks) and the private bucket's policies (signed links
// only for visible documents, uploads only to your own pending path, no
// overwrite, deletes only of pending files).
import { act, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { Linking } from 'react-native';
import {
  makeDocument,
  makeFolder,
  makeNotification,
  makeSession,
  pickedFile,
  sampleCommunities,
  TEST_USER_ID,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { openHub, renderApp } from '@/testing/render';

afterEach(() => jest.restoreAllMocks());

type User = ReturnType<typeof userEvent.setup>;

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // the user is the Owner: documents.view + upload + manage
const C = choir.community_id; // the user is a Member: documents.view only
const UPLOADER = { [C]: ['documents.view', 'documents.upload'] }; // a custom "Uploader" role

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const minutes = (folder: string) => makeFolder(C, 1, { name: 'Minutes', id: folder });
const FOLDER = 'f7f7f7f7-0000-4000-8000-000000000001';

/** Documents of a community (ids unique per community). */
const docsFor = (communityId: string, o = communityId === M ? 50 : 0) => [
  makeDocument(communityId, o + 1, { name: 'Bylaws.pdf', created_at: ago(1), uploaded_at: ago(1) }),
  makeDocument(communityId, o + 2, {
    name: 'Budget.xlsx',
    file_extension: 'xlsx',
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    file_size: 2_500_000,
    created_at: ago(2),
    uploaded_at: ago(2),
  }),
  makeDocument(communityId, o + 3, { name: 'Board notes.pdf', visibility: 'managers', created_at: ago(3) }),
  makeDocument(communityId, o + 4, { name: 'Old rules.pdf', status: 'archived', created_at: ago(4) }),
  makeDocument(communityId, o + 5, { name: 'Gone.pdf', status: 'deleted', created_at: ago(5) }),
  makeDocument(communityId, o + 6, {
    name: 'Half uploaded.pdf',
    status: 'pending_upload',
    uploaded_at: null,
    created_at: ago(6),
  }),
  makeDocument(communityId, o + 7, {
    name: 'March minutes.pdf',
    folder_id: communityId === C ? FOLDER : null,
    created_at: ago(7),
  }),
  makeDocument(communityId, o + 8, {
    name: 'My flyer.pdf',
    uploaded_by: TEST_USER_ID,
    created_at: ago(8),
  }),
];

const content = () => ({
  [C]: { documents: docsFor(C), folders: [minutes(FOLDER)] },
  [M]: { documents: docsFor(M) },
});

/** Signed in with one community, on its Documents screen. */
async function openDocuments(options: FakeOptions = {}) {
  const user = userEvent.setup();
  const app = await renderApp({
    session: makeSession(),
    communities: [choir],
    content: content(),
    ...options,
  });
  await openHub();
  await user.press(screen.getByRole('button', { name: 'Documents' }));
  await screen.findByTestId('documents-screen');
  await screen.findByTestId('documents-list');
  return { user, ...app };
}

const listed = () =>
  within(screen.getByTestId('documents-list'))
    .queryAllByRole('button', { name: /^Document: / })
    .map((b) => (b.props.accessibilityLabel as string).replace(/^Document: /, '').split('.')[0]);

const docRow = (name: string) => screen.findByRole('button', { name: new RegExp(`^Document: ${name}`) });
const rpcCalls = (rpc: jest.Mock, name: string) => rpc.mock.calls.filter(([n]) => n === name);

async function openDocument(user: User, name: string) {
  await user.press(await docRow(name));
  return screen.findByTestId('document-detail-screen');
}

describe('document list', () => {
  test('a member sees active, members-visible documents, newest first, with their folders', async () => {
    await openDocuments();
    expect(listed()).toEqual(['Bylaws', 'Budget', 'My flyer']);
    // Restricted, archived, deleted, pending and other communities' documents are not sent at all.
    expect(screen.queryByText(/Board notes|Old rules|Gone|Half uploaded/)).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Folder: Minutes' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: /^Document: Budget.xlsx/ }).props.accessibilityLabel).toMatch(
      /Excel, 2\.4 MB/,
    );
    // No upload or archive controls without the permissions.
    expect(screen.queryByRole('button', { name: 'Upload a document' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('tab', { name: 'Archived' })).not.toBeOnTheScreen();
  });

  test('a folder opens its documents', async () => {
    const { user } = await openDocuments();
    await user.press(screen.getByRole('button', { name: 'Folder: Minutes' }));
    await waitFor(() => expect(listed()).toEqual(['March minutes']));
    expect(screen.queryByRole('button', { name: 'Folder: Minutes' })).not.toBeOnTheScreen();
  });

  test('an empty community', async () => {
    await openDocuments({ content: {} });
    expect(await screen.findByText('No documents yet.')).toBeOnTheScreen();
  });

  test('a manager also sees restricted documents (marked) and the archive', async () => {
    const { user } = await openDocuments({ communities: [maple] });
    expect(listed()).toEqual(['Bylaws', 'Budget', 'Board notes', 'March minutes', 'My flyer']);
    expect(screen.getByRole('button', { name: /^Document: Board notes/ }).props.accessibilityLabel).toMatch(
      /Managers only/,
    );
    await user.press(screen.getByRole('tab', { name: 'Archived' }));
    await waitFor(() => expect(listed()).toEqual(['Old rules']));
    expect(screen.getByRole('button', { name: 'Upload a document' })).toBeOnTheScreen();
  });

  test('pages of 20 with "Load more"', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      makeDocument(C, i + 1, { name: `Doc ${i + 1}.pdf`, created_at: ago(i + 1) }),
    );
    const { user, rpc } = await openDocuments({ content: { [C]: { documents: many } } });
    const held = () => (screen.getByTestId('documents-list').props.data as unknown[]).length;
    expect(held()).toBe(20);
    await user.press(screen.getByRole('button', { name: 'Load more documents' }));
    await waitFor(() => expect(held()).toBe(25));
    expect(rpcCalls(rpc, 'list_documents').at(-1)![1]).toMatchObject({ p_cursor_id: many[19]!.id });
    expect(screen.queryByRole('button', { name: 'Load more documents' })).not.toBeOnTheScreen();
  });
});

describe('details and download', () => {
  test('a document opens through a short-lived signed link, never a permanent URL', async () => {
    const { user, documentsStorage } = await openDocuments();
    await openDocument(user, 'Bylaws');
    expect(screen.getByTestId('document-facts')).toHaveTextContent(/PDF · 117 KB · Added/);
    expect(screen.queryByTestId('document-controls')).not.toBeOnTheScreen();
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await user.press(screen.getByRole('button', { name: 'Open document' }));
    await waitFor(() => expect(openURL).toHaveBeenCalledTimes(1));
    expect(documentsStorage.createSignedUrl).toHaveBeenCalledWith(
      `communities/${C}/documents/b8b8b8b8-0000-4000-8000-000000000001/file.pdf`,
      60,
    );
    expect(openURL.mock.calls[0]![0]).toMatch(/expires=60$/);
    expect(documentsStorage).not.toHaveProperty('getPublicUrl');
  });

  test('a refused link says so and opens nothing', async () => {
    const { user, documentFiles } = await openDocuments();
    await openDocument(user, 'Bylaws');
    // Storage refuses (e.g. the file was removed meanwhile).
    documentFiles.clear();
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await user.press(screen.getByRole('button', { name: 'Open document' }));
    expect(await screen.findByTestId('document-error')).toHaveTextContent(/no longer available/);
    expect(openURL).not.toHaveBeenCalled();
  });
});

describe('unauthorized and cross-community access', () => {
  test('another community’s document, reached by a link, is refused', async () => {
    const foreign = makeDocument(M, 51);
    const n = makeNotification(1, {
      community_id: C,
      title: 'Look at this',
      data: { document_id: foreign.id },
    });
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [maple, choir],
      content: content(),
      notifications: [n],
      initialURL: `communione://notifications/${n.id}`,
    });
    await user.press(await screen.findByRole('button', { name: 'Open the document' }));
    expect(await screen.findByText('This document is not available')).toBeOnTheScreen();
    expect(screen.queryByText('Bylaws.pdf')).not.toBeOnTheScreen();
  });

  test('a restricted document is refused to a member, even by id', async () => {
    const restricted = docsFor(C)[2]!;
    const { dependencies } = await openDocuments();
    await expect(dependencies.services.documents.get(restricted.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(dependencies.services.documents.getDownloadUrl(restricted.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('hidden buttons are not the protection: the backend refuses member writes', async () => {
    const { dependencies, content: server } = await openDocuments();
    const { documents } = dependencies.services;
    const bylaws = docsFor(C)[0]!;
    await expect(documents.rename(bylaws.id, 'Mine now.pdf')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(documents.delete(bylaws.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(documents.archive(bylaws.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      documents.beginUpload({ communityId: C, name: 'x.pdf', mimeType: 'application/pdf', size: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Nor into a community they are not a member of (with a folder of this one).
    await expect(
      documents.beginUpload({
        communityId: M,
        name: 'x.pdf',
        mimeType: 'application/pdf',
        size: 10,
        folderId: FOLDER,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(server[C]!.documents!.find((d) => d.id === bylaws.id)).toMatchObject({
      name: 'Bylaws.pdf',
      status: 'active',
    });
  });

  test('storage: no uploads outside your own pending path, no overwrites, no deletes of active files', async () => {
    const { documentsStorage, documentFiles } = await openDocuments({ permissions: UPLOADER });
    const active = docsFor(C)[0]!;
    const theirPending = docsFor(C)[5]!; // pending, uploaded by someone else
    const bytes = { byteLength: 10 };
    expect((await documentsStorage.upload(active.storage_path, bytes)).error).toBeTruthy();
    expect((await documentsStorage.upload(theirPending.storage_path, bytes)).error).toBeTruthy();
    expect(
      (await documentsStorage.upload(`communities/${C}/documents/x/../../evil.pdf`, bytes)).error,
    ).toBeTruthy();
    expect((await documentsStorage.remove([active.storage_path])).data).toEqual([]);
    expect(documentFiles.has(active.storage_path)).toBe(true);
  });
});

/** Uploader (choir), on the upload screen with a file chosen. */
async function startUpload(options: FakeOptions = {}, file = pickedFile('Minutes April.pdf', 120_000)) {
  const app = await openDocuments({ permissions: UPLOADER, ...options });
  app.media.nextFile(file);
  await app.user.press(screen.getByRole('button', { name: 'Upload a document' }));
  await screen.findByTestId('document-upload-screen');
  await app.user.press(screen.getByRole('button', { name: 'Choose a file' }));
  return app;
}

describe('upload', () => {
  test('shows the supported types and limit; uploads with progress to the server’s path', async () => {
    const app = await startUpload();
    const { user, rpc, uploadFile, documentFiles, holdDocumentUploads, releaseDocumentUpload } = app;
    expect(screen.getByTestId('document-upload-rules')).toHaveTextContent(
      /Supported: PDF, Word, Excel, PowerPoint, images \(PNG, JPEG, WEBP\), text and CSV\. Up to 25 MB\./,
    );
    expect(screen.getByTestId('document-upload-file')).toHaveTextContent(/Minutes April\.pdf.*PDF · 117 KB/);
    expect(screen.getByDisplayValue('Minutes April.pdf')).toBeOnTheScreen();
    // No "managers only" choice without documents.manage.
    expect(screen.queryByRole('switch', { name: 'Managers only' })).not.toBeOnTheScreen();

    holdDocumentUploads();
    await user.press(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('Uploading… 50%')).toBeOnTheScreen();
    expect(screen.getByRole('progressbar').props.accessibilityValue).toEqual({ min: 0, max: 100, now: 50 });
    await act(async () => releaseDocumentUpload());

    expect(await screen.findByTestId('document-detail-screen')).toBeOnTheScreen();
    expect(screen.getByTestId('document-name')).toHaveTextContent('Minutes April.pdf');
    expect(screen.getByTestId('document-access')).toHaveTextContent(/Uploaded by you/);
    const [, args] = rpcCalls(rpc, 'create_document_upload')[0]!;
    expect(args).toMatchObject({
      p_community_id: C,
      p_name: 'Minutes April.pdf',
      p_mime_type: 'application/pdf',
      p_file_size: 120_000,
      p_visibility: 'members',
    });
    const id = (rpcCalls(rpc, 'complete_document_upload')[0]![1] as { p_document_id: string }).p_document_id;
    const path = `communities/${C}/documents/${id}/file.pdf`;
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'documents', path, contentType: 'application/pdf' }),
    );
    expect(documentFiles.get(path)).toEqual({ size: 120_000, mimetype: 'application/pdf' });
  });

  test('the new document is in the list (and the folder it was uploaded into)', async () => {
    const { user, rpc, media } = await openDocuments({ permissions: UPLOADER });
    await user.press(screen.getByRole('button', { name: 'Folder: Minutes' }));
    await waitFor(() => expect(listed()).toEqual(['March minutes']));
    media.nextFile(pickedFile('April minutes.docx', 50_000, null));
    await user.press(screen.getByRole('button', { name: 'Upload a document' }));
    expect(await screen.findByText('Into Minutes')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Choose a file' }));
    await user.press(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('document-detail-screen');
    expect(rpcCalls(rpc, 'create_document_upload')[0]![1]).toMatchObject({
      p_folder_id: FOLDER,
      // The type comes from the extension when the picker gives none.
      p_mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  test('unsupported types and oversized files are refused before anything is sent', async () => {
    const { user, rpc, media, uploadFile } = await startUpload(
      {},
      pickedFile('setup.exe', 1000, 'application/x-msdownload'),
    );
    expect(screen.getByTestId('document-upload-error')).toHaveTextContent(
      /can't be uploaded\. Supported: PDF/,
    );
    expect(screen.queryByTestId('document-upload-file')).not.toBeOnTheScreen();

    media.nextFile(pickedFile('page.html', 1000, 'text/html'));
    await user.press(screen.getByRole('button', { name: 'Choose a file' }));
    expect(screen.getByTestId('document-upload-error')).toHaveTextContent(/can't be uploaded/);

    media.nextFile(pickedFile('Scan.pdf', 30 * 1024 * 1024));
    await user.press(screen.getByRole('button', { name: 'Choose a file' }));
    expect(screen.getByTestId('document-upload-error')).toHaveTextContent(
      /too large \(30 MB\)\. The limit is 25 MB/,
    );
    media.nextFile(pickedFile('Empty.pdf', 0));
    await user.press(screen.getByRole('button', { name: 'Choose a file' }));
    expect(screen.getByTestId('document-upload-error')).toHaveTextContent(/empty/);

    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(rpcCalls(rpc, 'create_document_upload')).toHaveLength(0);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  test('a size the picker did not report is checked after reading', async () => {
    const unknown = { ...pickedFile('Big.pdf', 30 * 1024 * 1024), size: null };
    const { user, rpc } = await startUpload({}, unknown);
    await user.press(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByTestId('document-upload-error')).toHaveTextContent(/too large/);
    expect(rpcCalls(rpc, 'create_document_upload')).toHaveLength(0);
  });

  test('cancel mid-transfer: nothing is stored and the reservation is closed', async () => {
    const { user, rpc, holdDocumentUploads, documentFiles, content: server } = await startUpload();
    holdDocumentUploads();
    await user.press(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByText('Uploading… 50%');
    await user.press(screen.getByRole('button', { name: 'Cancel upload' }));
    expect(await screen.findByTestId('document-upload-notice')).toHaveTextContent(/Upload cancelled\./);
    expect(rpcCalls(rpc, 'complete_document_upload')).toHaveLength(0);
    const reserved = server[C]!.documents!.find((d) => d.name === 'Minutes April.pdf')!;
    expect(reserved.status).toBe('deleted');
    expect(documentFiles.has(reserved.storage_path as string)).toBe(false);
    // The file is still chosen: it can be uploaded again.
    expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
  });

  test('a failed transfer shows the problem; "Try again" resumes without a second document', async () => {
    const { user, rpc, failDocumentUploads, content: server } = await startUpload();
    failDocumentUploads(1);
    await user.press(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByTestId('document-upload-error')).toHaveTextContent(/couldn't reach CommuniOne/);
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('document-detail-screen')).toBeOnTheScreen();
    expect(rpcCalls(rpc, 'create_document_upload')).toHaveLength(1);
    expect(server[C]!.documents!.filter((d) => d.name === 'Minutes April.pdf')).toHaveLength(1);
  });

  test('a failed completion retries only the completion', async () => {
    const { user, rpc, failRpcOnce, uploadFile } = await startUpload();
    failRpcOnce('complete_document_upload');
    await user.press(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByTestId('document-upload-error')).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('document-detail-screen');
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(rpcCalls(rpc, 'complete_document_upload')).toHaveLength(2);
  });

  test('discarding a failed upload closes the reservation', async () => {
    const { user, failDocumentUploads, content: server } = await startUpload();
    failDocumentUploads(1);
    await user.press(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('document-upload-error');
    await user.press(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(server[C]!.documents!.find((d) => d.name === 'Minutes April.pdf')!.status).toBe('deleted'),
    );
    expect(screen.queryByTestId('document-upload-error')).not.toBeOnTheScreen();
  });

  test('a refused upload (permission removed meanwhile) says so and reserves nothing', async () => {
    const permissions = { ...UPLOADER };
    const { user, content: server } = await startUpload({ permissions });
    permissions[C] = ['documents.view'];
    await user.press(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByTestId('document-upload-error')).toHaveTextContent(
      /You don't have permission to do that\./,
    );
    expect(server[C]!.documents!.some((d) => d.name === 'Minutes April.pdf')).toBe(false);
  });

  test('a manager can upload for managers only', async () => {
    const { user, rpc, media } = await openDocuments({ communities: [maple] });
    media.nextFile(pickedFile('Board pack.pdf'));
    await user.press(screen.getByRole('button', { name: 'Upload a document' }));
    await user.press(await screen.findByRole('button', { name: 'Choose a file' }));
    await user.press(screen.getByRole('switch', { name: 'Managers only' }));
    await user.press(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('document-detail-screen');
    expect(rpcCalls(rpc, 'create_document_upload')[0]![1]).toMatchObject({ p_visibility: 'managers' });
    expect(screen.getByTestId('document-access')).toHaveTextContent(/Managers only/);
  });
});

/** Back to the list: the Communities tab pops its stack to the hub. */
async function backToList(user: User) {
  await user.press(screen.getByRole('button', { name: /^Communities/ }));
  await user.press(await screen.findByRole('button', { name: 'Documents' }));
  await screen.findByTestId('documents-list');
}

describe('rename, archive and delete', () => {
  test('an uploader renames and deletes their own document, not others’', async () => {
    const { user, documentsStorage, content: server } = await openDocuments({ permissions: UPLOADER });
    await openDocument(user, 'Bylaws');
    expect(screen.queryByTestId('document-controls')).not.toBeOnTheScreen();

    await backToList(user);
    await openDocument(user, 'My flyer');
    await user.press(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByDisplayValue('My flyer.pdf');
    await user.clear(field);
    await user.type(field, '  Summer flyer.pdf ');
    await user.press(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByTestId('document-done')).toHaveTextContent(/Renamed\./);
    // The name is display only: the stored path never changes.
    expect(screen.getByTestId('document-name')).toHaveTextContent('Summer flyer.pdf');
    const flyer = server[C]!.documents!.find((d) => d.uploaded_by === TEST_USER_ID)!;
    expect(flyer.storage_path).toBe(`communities/${C}/documents/${flyer.id}/file.pdf`);
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeOnTheScreen();

    await user.press(screen.getByRole('button', { name: 'Delete document' }));
    expect(screen.getByText(/Delete this document\?/)).toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(listed()).toEqual(['Bylaws', 'Budget']));
    expect(flyer.status).toBe('deleted');
    // Its file is unreadable at once.
    expect((await documentsStorage.createSignedUrl(flyer.storage_path as string, 60)).error).toBeTruthy();
  });

  test('a manager archives (members stop seeing it) and restores any document', async () => {
    const { user, content: server } = await openDocuments({ communities: [maple] });
    await openDocument(user, 'Budget');
    await user.press(screen.getByRole('button', { name: 'Archive' }));
    expect(await screen.findByTestId('document-done')).toHaveTextContent(/Archived\./);
    expect(screen.getByText(/This document is archived/)).toBeOnTheScreen();
    const budget = server[M]!.documents!.find((d) => d.name === 'Budget.xlsx')!;
    expect(budget.status).toBe('archived');
    await user.press(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByTestId('document-done')).toHaveTextContent(/Restored\./);
    expect(budget.status).toBe('active');
  });

  test('a delete refused by the server is reported and the document stays', async () => {
    const { user, failNextQuery, content: server } = await openDocuments({ communities: [maple] });
    await openDocument(user, 'Bylaws');
    failNextQuery({ code: '42501', message: 'permission denied for table documents' });
    await user.press(screen.getByRole('button', { name: 'Delete document' }));
    await user.press(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByTestId('document-error')).toHaveTextContent(
      /You don't have permission to do that\./,
    );
    expect(server[M]!.documents!.find((d) => d.name === 'Bylaws.pdf')!.status).toBe('active');
  });
});
