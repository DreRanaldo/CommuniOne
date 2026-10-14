import { base64ToBytes, readFileBytes } from './media';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

test('base64 (with or without a data: prefix) becomes the exact bytes', () => {
  expect([...base64ToBytes('/9j/2Q==')]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  expect([...base64ToBytes('data:image/jpeg;base64,/9j/\n2Q==')]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
});

test('local files are read with XMLHttpRequest as bytes', async () => {
  const opened: string[] = [];
  class FakeXhr {
    responseType = '';
    response: ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open(_method: string, url: string) {
      opened.push(url);
    }
    send() {
      if (opened.at(-1)!.includes('missing')) this.onerror?.();
      else {
        this.response = new Uint8Array([1, 2, 3]).buffer;
        this.onload?.();
      }
    }
  }
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
  expect([...(await readFileBytes('file:///cache/Minutes.pdf'))]).toEqual([1, 2, 3]);
  await expect(readFileBytes('file:///cache/missing.pdf')).rejects.toThrow('could not be read');
});
