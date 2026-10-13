// Documents and file storage: upload (two-phase), download links, list,
// rename / move / archive / delete, and folders.
//
// Upload: create_document_upload() validates permission, type, size and
// folder and reserves a server-generated path; the file is then uploaded to
// that exact path (Storage policy), and complete_document_upload() checks the
// stored object's real size and type before the document becomes visible.

import { ErrorCode, networkError, ServiceError } from '../core/errors.ts';
import { byteLength, storageUploader, UploadError, type FileUploader, type UploadBody } from '../core/files.ts';
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

/** What the server accepts (document_upload_settings, document_mime_types): for validating in the UI. */
export interface UploadRules {
  maxFileSize: number;
  types: { mimeType: string; extension: string }[];
}

/** A reserved upload (phase 1): the document is pending and invisible to members. */
export interface PendingUpload {
  documentId: string;
  maxFileSize: number;
}

export interface SendOptions {
  /** Bytes sent so far, out of total. */
  onProgress?: (sent: number, total: number) => void;
  /** Aborting cancels the transfer (then call cancelUpload to discard the reservation). */
  signal?: AbortSignal;
}

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
  if ((typeof Blob !== 'undefined' && file instanceof Blob) || file instanceof ArrayBuffer || file instanceof Uint8Array) return byteLength(file);
  return v.fail('file', 'file must be a Blob, ArrayBuffer or Uint8Array.');
};

const CANCELLED = () => new ServiceError(ErrorCode.Conflict, 'The upload was cancelled.', { cancelled: true });

export function documentsService(ctx: ServiceContext, uploadFile?: FileUploader) {
  const { db } = ctx;
  const transport = uploadFile ?? storageUploader(db as never);

  /** The caller's own pending upload, read through RLS: the path, type and size come from the server. */
  const pendingOf = async (documentId: string, userId: string) => {
    const row = unwrapOne(await db.from('documents').select('id, storage_path, mime_type, file_size, status, uploaded_by')
      .eq('id', v.uuid(documentId, 'documentId')).maybeSingle(), 'Upload not found.');
    if (row.status !== 'pending_upload' || row.uploaded_by !== userId || !row.storage_path) {
      throw new ServiceError(ErrorCode.NotFound, 'Upload not found.');
    }
    return row;
  };

  const begin = async (input: Omit<UploadInput, 'file'> & { size: number }): Promise<PendingUpload> => {
    const size = v.int(input.size, 'size', 1, Number.MAX_SAFE_INTEGER);
    const reserved = firstRow(unwrap(await db.rpc('create_document_upload', {
      p_community_id: v.uuid(input.communityId, 'communityId'),
      p_name: docName(input.name),
      p_mime_type: mimeType(input.mimeType),
      p_file_size: size,
      p_folder_id: v.optionalUuid(input.folderId, 'folderId') ?? undefined,
      p_visibility: input.visibility === undefined ? 'members' : v.oneOf(input.visibility, 'visibility', DOCUMENT_VISIBILITIES),
    })));
    return { documentId: reserved.document_id, maxFileSize: Number(reserved.max_file_size_bytes) };
  };

  const send = async (documentId: string, file: UploadBody, options: SendOptions = {}): Promise<void> => {
    const userId = await ctx.requireUserId();
    const pending = await pendingOf(documentId, userId);
    const size = sizeOf(file);
    if (size !== Number(pending.file_size)) v.fail('file', 'The file changed since the upload started. Start again.');
    if (options.signal?.aborted) throw CANCELLED();
    try {
      await transport({
        bucket: BUCKET,
        path: pending.storage_path as string,
        body: file,
        contentType: pending.mime_type,
        onProgress: options.onProgress,
        signal: options.signal,
      });
    } catch (thrown) {
      const e = thrown instanceof UploadError ? thrown : new UploadError(thrown instanceof Error ? thrown.message : 'Upload failed.');
      if (e.aborted || options.signal?.aborted) throw CANCELLED();
      // Already stored by an earlier attempt whose answer was lost: nothing to resend.
      if (e.status === 409 || /already exists|duplicate/i.test(e.message)) return;
      if (e.status === 403 || /row-level security|unauthorized|not allowed/i.test(e.message)) {
        throw new ServiceError(ErrorCode.Forbidden, "You can't upload documents in this community.", {}, e);
      }
      if (e.status === 413 || /too large|exceeded the maximum/i.test(e.message)) {
        throw new ServiceError(ErrorCode.Validation, 'The file is too large.', { field: 'file' }, e);
      }
      if (e.status === 0) throw networkError(e);
      throw new ServiceError(ErrorCode.ServerError, 'The file could not be uploaded. Try again.', {}, e);
    }
  };

  const complete = async (documentId: string): Promise<Document> =>
    unwrap(await db.rpc('complete_document_upload', { p_document_id: v.uuid(documentId, 'documentId') })) as Document;

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
        const size = sizeOf(input.file);
        if (size < 1) v.fail('file', 'file is empty.');
        const { file, ...rest } = input;
        const pending = await begin({ ...rest, size });
        // On failure the pending row stays invisible to members; the purge job removes it.
        await send(pending.documentId, file);
        return complete(pending.documentId);
      });
    },

    /** The accepted types and the size limit (the server checks them again). */
    uploadRules(): Promise<UploadRules> {
      return ctx.run('documents.uploadRules', async () => {
        await ctx.requireUserId();
        const [settings, types] = await Promise.all([
          db.from('document_upload_settings').select('max_file_size_bytes').maybeSingle(),
          db.from('document_mime_types').select('mime_type, extension').eq('enabled', true).order('extension'),
        ]);
        const max = unwrapOne(settings, 'Upload settings not found.');
        return {
          maxFileSize: Number(max.max_file_size_bytes),
          types: (unwrap(types) ?? []).map((t) => ({ mimeType: t.mime_type, extension: t.extension })),
        };
      });
    },

    /**
     * Phase 1 of a step-by-step upload (for progress, cancel and retry):
     * validates permission, type, size and folder on the server and reserves
     * the document. Requires documents.upload.
     */
    beginUpload(input: Omit<UploadInput, 'file'> & { size: number }): Promise<PendingUpload> {
      return ctx.run('documents.beginUpload', async () => {
        await ctx.requireUserId();
        v.only<typeof input>(input, 'input', ['communityId', 'name', 'mimeType', 'size', 'folderId', 'visibility']);
        return begin(input);
      });
    },

    /**
     * Phase 2: sends the file to the path the server reserved for this
     * document (read back through RLS; never chosen by the caller). Safe to
     * retry: a file already stored by a lost attempt counts as sent.
     */
    sendFile(documentId: string, file: UploadBody, options?: SendOptions): Promise<void> {
      return ctx.run('documents.sendFile', () => send(documentId, file, options));
    },

    /** Phase 3: the server checks the stored file's real size and type, then the document becomes visible. */
    completeUpload(documentId: string): Promise<Document> {
      return ctx.run('documents.completeUpload', async () => {
        await ctx.requireUserId();
        return complete(documentId);
      });
    },

    /** Discards the caller's own pending upload: removes its file if any, and closes the reservation. */
    cancelUpload(documentId: string): Promise<void> {
      return ctx.run('documents.cancelUpload', async () => {
        const userId = await ctx.requireUserId();
        const pending = await pendingOf(documentId, userId);
        // Storage allows deleting only a pending upload's file (best effort; the purge job is the backstop).
        await db.storage.from(BUCKET).remove([pending.storage_path as string]).catch(() => undefined);
        await mutateOne(
          () => db.from('documents').update({ status: 'deleted' }).eq('id', pending.id).select('id'),
          () => db.from('documents').select('id').eq('id', pending.id),
          'Upload not found.',
        );
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
