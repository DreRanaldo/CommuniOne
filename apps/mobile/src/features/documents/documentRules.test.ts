import type { UploadRules } from '@communione/services';
import { checkFile, documentActions, formatSize, suggestedName, supportedTypes } from './documentRules';

const rules: UploadRules = {
  maxFileSize: 25 * 1024 * 1024,
  types: [
    { mimeType: 'application/pdf', extension: 'pdf' },
    { mimeType: 'image/jpeg', extension: 'jpg' },
    { mimeType: 'text/csv', extension: 'csv' },
  ],
};
const file = (name: string, mimeType: string | null = null, size: number | null = 1000) => ({
  name,
  mimeType,
  size,
});

describe('checkFile', () => {
  test('the type comes from the extension first, else from the picker', () => {
    expect(checkFile(file('a.PDF'), rules)).toEqual({
      ok: true,
      mimeType: 'application/pdf',
      extension: 'pdf',
    });
    expect(checkFile(file('photo.jpeg', 'application/octet-stream'), rules)).toMatchObject({
      mimeType: 'image/jpeg',
    });
    expect(checkFile(file('scan', 'application/pdf'), rules)).toMatchObject({
      ok: true,
      mimeType: 'application/pdf',
    });
  });

  test('a disguised or unknown file is refused', () => {
    // A .exe that claims to be a PDF: the extension wins, and it is not allowed.
    expect(checkFile(file('setup.exe', 'application/pdf'), rules)).toMatchObject({ ok: false });
    expect(checkFile(file('page.html', 'text/html'), rules)).toMatchObject({ ok: false });
    expect(checkFile(file('noext', null), rules)).toMatchObject({ ok: false });
  });

  test('size: empty and over the server limit are refused; unknown passes (checked after reading)', () => {
    expect(checkFile(file('a.pdf', null, 0), rules)).toEqual({ ok: false, message: 'This file is empty.' });
    expect(checkFile(file('a.pdf', null, rules.maxFileSize + 1), rules)).toMatchObject({ ok: false });
    expect(checkFile(file('a.pdf', null, rules.maxFileSize), rules)).toMatchObject({ ok: true });
    expect(checkFile(file('a.pdf', null, null), rules)).toMatchObject({ ok: true });
  });
});

test('wording', () => {
  expect(formatSize(120_000)).toBe('117 KB');
  expect(formatSize(2_500_000)).toBe('2.4 MB');
  expect(formatSize(25 * 1024 * 1024)).toBe('25 MB');
  expect(supportedTypes(rules)).toBe('PDF, images (JPEG) and CSV');
  expect(suggestedName('/private/var/cache/Minutes.pdf')).toBe('Minutes.pdf');
});

describe('documentActions (display only)', () => {
  const can = (keys: string[]) => (k: string) => keys.includes(k);
  const doc = (uploaded_by: string | null, status = 'active') => ({ uploaded_by, status });
  test('managers: everything; uploaders: their own; viewers: nothing', () => {
    expect(documentActions(doc('x'), 'me', can(['documents.manage']))).toEqual({
      rename: true,
      delete: true,
      archive: true,
    });
    expect(documentActions(doc('me'), 'me', can(['documents.upload']))).toEqual({
      rename: true,
      delete: true,
      archive: false,
    });
    expect(documentActions(doc('x'), 'me', can(['documents.upload']))).toEqual({
      rename: false,
      delete: false,
      archive: false,
    });
    // Without documents.upload, even your own document is read-only.
    expect(documentActions(doc('me'), 'me', can(['documents.view']))).toEqual({
      rename: false,
      delete: false,
      archive: false,
    });
    expect(documentActions(doc(null), null, can(['documents.upload']))).toEqual({
      rename: false,
      delete: false,
      archive: false,
    });
    expect(documentActions(doc('me', 'deleted'), 'me', can(['documents.manage'])).rename).toBe(false);
  });
});
