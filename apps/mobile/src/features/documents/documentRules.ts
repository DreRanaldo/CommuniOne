// Document wording and the checks made before an upload starts. These only
// spare the user a pointless upload: the server re-validates the type
// (allow-list, stored type), the size (declared and stored), the name, the
// folder and the permission, and decides the storage path.
import { ErrorCode, isServiceError, type Document, type UploadRules } from '@communione/services';
import type { IconName } from '@/components';
import type { PickedFile } from '@/lib/media';
import { errorMessage } from '@/utils/errors';

const KINDS: Record<string, { icon: IconName; label: string }> = {
  pdf: { icon: 'document-text-outline', label: 'PDF' },
  docx: { icon: 'document-outline', label: 'Word' },
  xlsx: { icon: 'grid-outline', label: 'Excel' },
  pptx: { icon: 'easel-outline', label: 'PowerPoint' },
  png: { icon: 'image-outline', label: 'PNG image' },
  jpg: { icon: 'image-outline', label: 'JPEG image' },
  webp: { icon: 'image-outline', label: 'WebP image' },
  txt: { icon: 'reader-outline', label: 'Text' },
  csv: { icon: 'list-outline', label: 'CSV' },
};

export const fileKind = (extension: string) =>
  KINDS[extension.toLowerCase()] ?? { icon: 'document-outline' as IconName, label: extension.toUpperCase() };

export function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) {
    const mb = bytes / 1_048_576;
    return `${mb >= 10 || Number.isInteger(mb) ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "PDF, Word, Excel, PowerPoint, images (PNG, JPEG, WebP), text and CSV" from the server's list. */
export function supportedTypes(rules: UploadRules): string {
  const exts = rules.types.map((t) => t.extension);
  const named = ['pdf', 'docx', 'xlsx', 'pptx'].filter((e) => exts.includes(e)).map((e) => KINDS[e]!.label);
  const images = ['png', 'jpg', 'webp'].filter((e) => exts.includes(e)).map((e) => e.toUpperCase());
  const parts = [...named];
  if (images.length) parts.push(`images (${images.join(', ').replace('JPG', 'JPEG')})`);
  if (exts.includes('txt')) parts.push('text');
  if (exts.includes('csv')) parts.push('CSV');
  const known = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'webp', 'txt', 'csv']);
  parts.push(...exts.filter((e) => !known.has(e)).map((e) => e.toUpperCase()));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
}

const extensionOf = (name: string) => {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  const ext = match?.[1]?.toLowerCase() ?? null;
  return ext === 'jpeg' ? 'jpg' : ext;
};

export type FileCheck = { ok: true; mimeType: string; extension: string } | { ok: false; message: string };

/**
 * Whether a picked file can be uploaded: a supported type (by its name's
 * extension, else the picker's type) and a size within the server's limit.
 */
export function checkFile(
  file: Pick<PickedFile, 'name' | 'mimeType' | 'size'>,
  rules: UploadRules,
): FileCheck {
  const ext = extensionOf(file.name);
  const byExtension = ext ? rules.types.find((t) => t.extension === ext) : undefined;
  const byType = rules.types.find((t) => t.mimeType === file.mimeType?.toLowerCase());
  const type = byExtension ?? (ext ? undefined : byType);
  if (!type) {
    return {
      ok: false,
      message: `This type of file can't be uploaded. Supported: ${supportedTypes(rules)}.`,
    };
  }
  if (file.size !== null && file.size < 1) return { ok: false, message: 'This file is empty.' };
  if (file.size !== null && file.size > rules.maxFileSize) {
    return {
      ok: false,
      message: `This file is too large (${formatSize(file.size)}). The limit is ${formatSize(rules.maxFileSize)}.`,
    };
  }
  return { ok: true, mimeType: type.mimeType, extension: type.extension };
}

/** The display name to suggest: the file name, without folders. */
export const suggestedName = (fileName: string) => fileName.split(/[\\/]/).pop()!.trim().slice(0, 255);

export interface DocumentActions {
  rename: boolean;
  delete: boolean;
  archive: boolean;
}

/**
 * Controls to show (the database decides again): managers everything; an
 * uploader with documents.upload may rename and delete their own documents.
 */
export function documentActions(
  doc: Pick<Document, 'status' | 'uploaded_by'>,
  userId: string | null,
  can: (permission: string) => boolean,
): DocumentActions {
  if (doc.status === 'deleted' || doc.status === 'pending_upload')
    return { rename: false, delete: false, archive: false };
  const manager = can('documents.manage');
  const own = userId !== null && doc.uploaded_by === userId && can('documents.upload');
  return { rename: manager || own, delete: manager || own, archive: manager };
}

/** Plain words for a failed document operation. */
export function documentError(error: unknown): string {
  if (isServiceError(error)) {
    if (error.code === ErrorCode.Forbidden) return "You don't have permission to do that.";
    if (error.code === ErrorCode.NotFound) return 'This document is no longer available.';
    if (error.code === ErrorCode.RateLimited) return 'Too many uploads. Try again later.';
  }
  return errorMessage(error);
}
