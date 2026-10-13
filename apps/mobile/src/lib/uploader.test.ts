import { UploadError } from '@communione/services';
import { createXhrUploader } from './uploader';

type Listener = ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;

class FakeXhr {
  static last: FakeXhr;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = '';
  upload: { onprogress: Listener } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body = '{}') {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

const config = { supabaseUrl: 'https://project.supabase.co/', supabaseAnonKey: 'anon-key' };
const client = (token: string | null = 'user-jwt') =>
  ({
    auth: {
      getSession: async () => ({ data: { session: token ? { access_token: token } : null } }),
    },
  }) as never;
const request = (extra = {}) => ({
  bucket: 'documents',
  path: 'communities/c1/documents/d1/file.pdf',
  body: new Uint8Array(100),
  contentType: 'application/pdf',
  ...extra,
});
const sent = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return FakeXhr.last;
};

beforeEach(() => {
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
});

test("posts to the reserved path with the user's token and the anon key, never overwriting", async () => {
  const progress: number[] = [];
  const done = createXhrUploader(
    config,
    client(),
  )(request({ onProgress: (s: number, t: number) => progress.push(s / t) }));
  const xhr = await sent();
  expect(xhr.method).toBe('POST');
  expect(xhr.url).toBe(
    'https://project.supabase.co/storage/v1/object/documents/communities/c1/documents/d1/file.pdf',
  );
  expect(xhr.headers).toMatchObject({
    Authorization: 'Bearer user-jwt',
    apikey: 'anon-key',
    'Content-Type': 'application/pdf',
    'x-upsert': 'false',
  });
  xhr.upload.onprogress!({ lengthComputable: true, loaded: 40, total: 100 });
  xhr.respond(200);
  await done;
  expect(progress).toEqual([0, 0.4]);
});

test('refusals keep their meaning: 403 (policy), 409 (already stored), offline', async () => {
  const upload = createXhrUploader(config, client());
  let pending = upload(request());
  (await sent()).respond(
    400,
    JSON.stringify({ statusCode: '403', message: 'new row violates row-level security policy' }),
  );
  await expect(pending).rejects.toMatchObject({ status: 403 });

  pending = upload(request());
  (await sent()).respond(400, JSON.stringify({ statusCode: '409', message: 'The resource already exists' }));
  await expect(pending).rejects.toMatchObject({ status: 409 });

  pending = upload(request());
  (await sent()).onerror!();
  await expect(pending).rejects.toMatchObject({ status: 0, aborted: false });
});

test('aborting cancels the transfer', async () => {
  const controller = new AbortController();
  const pending = createXhrUploader(config, client())(request({ signal: controller.signal }));
  const xhr = await sent();
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(UploadError);
  await expect(pending).rejects.toMatchObject({ aborted: true });
  expect(xhr.aborted).toBe(true);
});

test('signed out: nothing is sent', async () => {
  await expect(createXhrUploader(config, client(null))(request())).rejects.toMatchObject({ status: 401 });
});
