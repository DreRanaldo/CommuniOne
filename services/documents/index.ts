// Documents and file storage: upload (two-phase), download links, list,
// rename / move / archive / delete, and folders.
//
// Upload: create_document_upload() validates permission, type, size and
// folder and reserves a server-generated path; the file is then uploaded to
// that exact path (Storage policy), and complete_document_upload() checks the
// stored object's real size and type before the document becomes visible.

import { ErrorCode, ServiceError } from '../core/errors.ts';
import { firstRow, mutateOne, unwrap, unwrapOne, type ServiceContext } from '../core/context.ts';
import { decodeCursor, pageSize, toPage, type Page, type PageRequest } from '../core/pagination.ts';
import * as v from '../core/validate.ts';
import type { Database, Tables } from '../database.types.ts';

export type Document = Tables<'documents'>;
export type Folder = Tables<'document_folders'>;

export const DOCUMENT_VISIBILITIES = ['members', 'managers'] as const;
export const DOCUMENT_STATUSES = ['active', 'archived', 'deleted', 'pending_upload'] as const;
export const BUCKET = 'documents';
/** Signed download links are short-lived. */
export const MAX_LINK_SECONDS = 300;

export interface UploadInput {
  communityId: string;
  name: string;
  mimeType: string;
  /** The file content: Blob / File (browser, React Native) or bytes. */
  file: Blob | ArrayBuffer | Uint8Array;
  folderId?: string | null;
  visibility?: (typeof DOCUMENT_VISIBILITIES)[number];
}

const docName = (value: unknown) => v.text(value, 'name', { max: 255, pattern: /^[^/\\]+$/, patternMessage: 'name must not contain slashes.' });
const folderName = (value: unknown) => v.text(value, 'name', { max: 120, pattern: /^[^/\\]+$/, patternMessage: 'name must not contain slashes.' });
const mimeType = (value: unknown) => v.text(value, 'mimeType', { max: 127, pattern: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i }).toLowerCase();

const sizeOf = (file: UploadInput['file']): number => {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file.size;
  if (file instanceof ArrayBuffer) return file.byteLength;
  if (file instanceof Uint8Array) return file.byteLength;
  return v.fail('file', 'file must be a Blob, ArrayBuffer or Uint8Array.');
};

export function documentsService(ctx: ServiceContext) {
  const { db } = ctx;

  const update = (operation: string, id: string, patch: () => Database['public']['Tables']['documents']['Update']) =>
    ctx.run(operation, async () => {
      await ctx.requireUserId();
      const values = patch();
      const documentId = v.uuid(id, 'documentId');
      return mutateOne(
        () => db.from('documents').update(values).eq('id', documentId).select('*'),
        () => db.from('documents').select('id').eq('id', documentId),
        'Document not found.',
      );
    });

  return {
    /** Requires documents.upload ('managers' visibility: documents.manage). Returns the active document. */
    upload(input: UploadInput): Promise<Document> {
      return ctx.run('documents.upload', async () => {
        await ctx.requireUserId();
        v.only<UploadInput>(input, 'input', ['communityId', 'name', 'mimeType', 'file', 'folderId', 'visibility']);
        const type = mimeType(input.mimeType);
        const size = sizeOf(input.file);
        if (size < 1) v.fail('file', 'file is empty.');
        const reserved = firstRow(unwrap(await db.rpc('create_document_upload', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_name: docName(input.name),
          p_mime_type: type,
          p_file_size: size,
          p_folder_id: v.optionalUuid(input.folderId, 'folderId') ?? undefined,
          p_visibility: input.visibility === undefined ? 'members' : v.oneOf(input.visibility, 'visibility', DOCUMENT_VISIBILITIES),
        })));
        // Storage takes a Blob's own type over the contentType option, so make
        // sure the stored type is the validated one.
        const content = typeof Blob !== 'undefined' && input.file instanceof Blob && input.file.type !== type
          ? new Blob([input.file], { type })
          : input.file;
        const stored = await db.storage.from(BUCKET).upload(reserved.storage_path, content, { contentType: type, upsert: false });
        if (stored.error) {
          // The pending row stays invisible to members and is cleaned up by the purge job.
          throw new ServiceError(ErrorCode.ServerError, 'The file could not be uploaded. Try again.', {}, stored.error);
        }
        return unwrap(await db.rpc('complete_document_upload', { p_document_id: reserved.document_id })) as Document;
      });
    },

    get(documentId: string): Promise<Document> {
      return ctx.run('documents.get', async () => {
        await ctx.requireUserId();
        return unwrapOne(await db.from('documents').select('*').eq('id', v.uuid(documentId, 'documentId')).maybeSingle(), 'Document not found.');
      });
    },

    /**
     * A short-lived download link. The document must be visible to the caller
     * (RLS) and Storage re-checks access when the link is created.
     */
    getDownloadUrl(documentId: string, expiresInSeconds = 60): Promise<string> {
      return ctx.run('documents.getDownloadUrl', async () => {
        await ctx.requireUserId();
        const seconds = v.int(expiresInSeconds, 'expiresInSeconds', 10, MAX_LINK_SECONDS);
        const doc = unwrapOne(await db.from('documents').select('storage_path, status')
          .eq('id', v.uuid(documentId, 'documentId')).maybeSingle(), 'Document not found.');
        if (!doc.storage_path || doc.status === 'deleted' || doc.status === 'pending_upload') {
          throw new ServiceError(ErrorCode.NotFound, 'Document not found.');
        }
        const signed = await db.storage.from(BUCKET).createSignedUrl(doc.storage_path, seconds);
        if (signed.error || !signed.data) throw new ServiceError(ErrorCode.NotFound, 'Document not found.', {}, signed.error);
        return signed.data.signedUrl;
      });
    },

    /** Newest first. Managers may list archived or deleted documents. */
    list(input: { communityId: string; folderId?: string; rootOnly?: boolean; statuses?: (typeof DOCUMENT_STATUSES)[number][] } & PageRequest): Promise<Page<Document>> {
      return ctx.run('documents.list', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'folderId', 'rootOnly', 'statuses', 'limit', 'cursor']);
        const limit = pageSize(input.limit);
        const c = decodeCursor(input.cursor, ['timestamp', 'uuid']);
        const rows = unwrap(await db.rpc('list_documents', {
          p_community_id: v.uuid(input.communityId, 'communityId'),
          p_folder_id: v.optionalUuid(input.folderId, 'folderId') ?? undefined,
          p_root_only: input.rootOnly === undefined ? false : v.bool(input.rootOnly, 'rootOnly'),
          p_statuses: input.statuses === undefined ? undefined : v.enumList(input.statuses, 'statuses', DOCUMENT_STATUSES),
          p_limit: limit,
          p_cursor_created_at: (c?.[0] as string | undefined) ?? undefined,
          p_cursor_id: (c?.[1] as string | undefined) ?? undefined,
        }));
        return toPage(rows, limit, (last) => [last.created_at, last.id]);
      });
    },

    rename: (documentId: string, name: string) => update('documents.rename', documentId, () => ({ name: docName(name) })),
    /** Move into a folder of the same community, or to the top level with null. */
    move: (documentId: string, folderId: string | null) =>
      update('documents.move', documentId, () => ({ folder_id: v.optionalUuid(folderId, 'folderId') })),
    /** documents.manage only. */
    setVisibility: (documentId: string, visibility: (typeof DOCUMENT_VISIBILITIES)[number]) =>
      update('documents.setVisibility', documentId, () => ({ visibility: v.oneOf(visibility, 'visibility', DOCUMENT_VISIBILITIES) })),
    archive: (documentId: string) => update('documents.archive', documentId, () => ({ status: 'archived' })),
    restore: (documentId: string) => update('documents.restore', documentId, () => ({ status: 'active' })),
    /** Soft delete: the file becomes unreadable at once and is purged later. */
    delete: (documentId: string) => update('documents.delete', documentId, () => ({ status: 'deleted' })),

    listFolders(communityId: string): Promise<Folder[]> {
      return ctx.run('documents.listFolders', async () => {
        await ctx.requireUserId();
        return unwrap(await db.from('document_folders').select('*')
          .eq('community_id', v.uuid(communityId, 'communityId')).order('name').limit(500)) ?? [];
      });
    },

    /** documents.manage. */
    createFolder(input: { communityId: string; name: string; parentFolderId?: string | null }): Promise<Folder> {
      return ctx.run('documents.createFolder', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'name', 'parentFolderId']);
        return unwrapOne(await db.from('document_folders').insert({
          community_id: v.uuid(input.communityId, 'communityId'),
          name: folderName(input.name),
          parent_folder_id: v.optionalUuid(input.parentFolderId, 'parentFolderId'),
        }).select('*').maybeSingle());
      });
    },

    deleteFolder(folderId: string): Promise<void> {
      return ctx.run('documents.deleteFolder', async () => {
        await ctx.requireUserId();
        const id = v.uuid(folderId, 'folderId');
        await mutateOne(
          () => db.from('document_folders').delete().eq('id', id).select('id'),
          () => db.from('document_folders').select('id').eq('id', id),
          'Folder not found.',
        );
      });
    },
  };
}
