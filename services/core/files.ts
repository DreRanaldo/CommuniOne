// Shared helpers for image uploads (avatars, community logo and cover).

import * as v from './validate.ts';

export const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
export type ImageMimeType = keyof typeof IMAGE_TYPES;
export type UploadBody = Blob | ArrayBuffer | Uint8Array;

/**
 * A random v4-shaped id for file names. Access is decided by storage
 * policies, so the name only needs to be unique and unguessable. Uses crypto
 * when the runtime has it.
 */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const byteLength = (file: UploadBody): number =>
  typeof Blob !== 'undefined' && file instanceof Blob ? file.size : file instanceof ArrayBuffer ? file.byteLength : (file as Uint8Array).byteLength;

/** Validates an image upload; returns its MIME type and file extension. */
export function checkImage(input: { file: UploadBody; mimeType: unknown }, maxBytes: number): { mimeType: ImageMimeType; ext: string } {
  const mimeType = v.oneOf(input.mimeType, 'mimeType', Object.keys(IMAGE_TYPES) as ImageMimeType[]);
  const size = byteLength(input.file);
  if (size < 1) v.fail('file', 'The image is empty.');
  if (size > maxBytes) v.fail('file', `The image is too large (at most ${Math.round(maxBytes / (1024 * 1024))} MB).`);
  return { mimeType, ext: IMAGE_TYPES[mimeType] };
}

/** A Blob whose type matches the declared MIME type (Storage checks it). */
export const uploadBody = (file: UploadBody, mimeType: string): UploadBody =>
  typeof Blob !== 'undefined' && file instanceof Blob && file.type !== mimeType ? new Blob([file], { type: mimeType }) : file;

/**
 * Sends one file to a Storage path the caller is authorized to write (the
 * storage policies decide). The default sends it through supabase-js; an app
 * can pass its own (e.g. XMLHttpRequest, for progress and cancellation) in
 * createServices({ uploadFile }). It must never choose the path itself.
 */
export type FileUploader = (request: FileUploadRequest) => Promise<void>;

export interface FileUploadRequest {
  bucket: string;
  path: string;
  body: UploadBody;
  contentType: string;
  /** Bytes sent so far, out of total. */
  onProgress?: (sent: number, total: number) => void;
  /** Aborting stops the transfer where the transport supports it. */
  signal?: AbortSignal;
}

/** How a transport reports a failed upload. */
export class UploadError extends Error {
  /** HTTP status from Storage (0: no response, e.g. offline). */
  readonly status: number;
  /** The transfer was cancelled (AbortSignal). */
  readonly aborted: boolean;
  constructor(message: string, status = 0, aborted = false) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.aborted = aborted;
  }
}

type StorageDb = { storage: { from(bucket: string): { upload(path: string, body: UploadBody, options: { contentType: string; upsert: boolean }): Promise<{ error: unknown }> } } };

/** The default transport: supabase-js (no byte progress; cancellation only before the transfer starts). */
export function storageUploader(db: StorageDb): FileUploader {
  return async ({ bucket, path, body, contentType, onProgress, signal }) => {
    const total = byteLength(body);
    if (signal?.aborted) throw new UploadError('The upload was cancelled.', 0, true);
    onProgress?.(0, total);
    const { error } = await db.storage.from(bucket).upload(path, uploadBody(body, contentType), { contentType, upsert: false });
    if (error) {
      const e = error as { statusCode?: string | number; status?: number; message?: string };
      throw new UploadError(e.message ?? 'Upload failed.', Number(e.statusCode ?? e.status ?? 0) || 0);
    }
    onProgress?.(total, total);
  };
}
