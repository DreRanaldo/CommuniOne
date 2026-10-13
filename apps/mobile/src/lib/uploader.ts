// Document uploads with progress and cancellation. supabase-js sends files
// with fetch(), which reports no upload progress and (in React Native) cannot
// be aborted mid-transfer, so the app sends the same Storage request with
// XMLHttpRequest instead: POST /storage/v1/object/<bucket>/<path>, with the
// signed-in user's access token and the public anon key, never overwriting
// (x-upsert: false). Storage applies the same policies as for supabase-js.
// The service layer decides the bucket and path; this only carries bytes.
import { UploadError, type FileUploader } from '@communione/services';
import type { PublicConfig } from './env';
import type { AppSupabaseClient } from './supabase';

export function createXhrUploader(config: PublicConfig, client: AppSupabaseClient): FileUploader {
  const base = config.supabaseUrl.replace(/\/+$/, '');
  return async ({ bucket, path, body, contentType, onProgress, signal }) => {
    if (signal?.aborted) throw new UploadError('The upload was cancelled.', 0, true);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new UploadError('You need to sign in.', 401);
    const url = `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const onAbort = () => xhr.abort();
      const done = () => signal?.removeEventListener('abort', onAbort);
      xhr.open('POST', url);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('apikey', config.supabaseAnonKey);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.setRequestHeader('cache-control', 'max-age=3600');
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) onProgress(event.loaded, event.total);
        };
      }
      xhr.onload = () => {
        done();
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        let message = `Upload failed (${xhr.status}).`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { message?: string; error?: string };
          message = parsed.message ?? parsed.error ?? message;
        } catch {
          // not JSON
        }
        // Storage reports some refusals as 400 with the real status in the body.
        const statusInBody = /already exists|duplicate/i.test(message)
          ? 409
          : /row-level security|unauthorized/i.test(message)
            ? 403
            : xhr.status;
        reject(new UploadError(message, statusInBody));
      };
      xhr.onerror = () => {
        done();
        reject(new UploadError('Network request failed', 0));
      };
      xhr.onabort = () => {
        done();
        reject(new UploadError('The upload was cancelled.', 0, true));
      };
      signal?.addEventListener('abort', onAbort);
      onProgress?.(0, body instanceof Blob ? body.size : body.byteLength);
      xhr.send(body as never);
    });
  };
}
