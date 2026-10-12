// Unit tests for the service layer's core: error translation, validation,
// pagination cursors, log redaction and the unauthenticated fast path.
// No database needed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { ErrorCode, ServiceError, fromDbError, toServiceError } from '../../services/core/errors.ts';
import * as v from '../../services/core/validate.ts';
import { decodeCursor, encodeCursor, pageSize, toPage, MAX_PAGE_SIZE } from '../../services/core/pagination.ts';
import { redact, safeLogger, type LogFields } from '../../services/core/logger.ts';
import { createServices, parseInvitationToken } from '../../services/index.ts';

const rejectsWith = async (promise: Promise<unknown>, code: string, field?: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (field) assert.equal(error.details.field, field);
    return true;
  });
};
const throwsWith = (fn: () => unknown, code: string, field?: string) => rejectsWith(Promise.resolve().then(fn), code, field);

describe('error translation', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ code: '42501', message: 'events.create is required in this community' }, ErrorCode.Forbidden],
    [{ code: '42501', message: 'authentication required' }, ErrorCode.Unauthenticated],
    [{ code: 'P0002', message: 'invitation not found' }, ErrorCode.NotFound],
    [{ code: '23505', message: 'duplicate key value violates unique constraint "x_key"' }, ErrorCode.Conflict],
    [{ code: '23514', message: 'new row for relation "posts" violates check constraint "posts_body_check"' }, ErrorCode.Validation],
    [{ code: '22P02', message: 'invalid input syntax for type uuid: "x"' }, ErrorCode.Validation],
    [{ code: '53400', message: 'rate limit exceeded', hint: 'retry_after_seconds=42' }, ErrorCode.RateLimited],
    [{ code: '55000', message: 'transfer the ability to manage roles first' }, ErrorCode.Conflict],
    [{ code: '40001', message: 'could not serialize access' }, ErrorCode.Conflict],
    [{ code: 'PGRST301', message: 'JWT expired' }, ErrorCode.Unauthenticated],
    [{ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, ErrorCode.NotFound],
    [{ code: 'XX000', message: 'internal error at /var/lib/postgresql' }, ErrorCode.ServerError],
    [{ code: '42P01', message: 'relation "secret_table" does not exist' }, ErrorCode.ServerError],
  ];
  for (const [error, code] of cases) {
    test(`${error.code} → ${code}`, () => assert.equal(fromDbError(error).code, code));
  }

  test('database internals never reach the client message', () => {
    const leaks = [
      { code: '42501', message: 'new row violates row-level security policy for table "posts"' },
      { code: '42501', message: 'permission denied for table invitations' },
      { code: '23514', message: 'new row for relation "posts" violates check constraint "posts_body_check"' },
      { code: '23505', message: 'duplicate key value violates unique constraint "communities_slug_key"' },
      { code: '23502', message: 'null value in column "body" of relation "posts" violates not-null constraint' },
      { code: 'XX000', message: 'could not open file "base/16384/2619": No such file' },
    ];
    for (const leak of leaks) {
      const json = JSON.stringify(fromDbError(leak));
      for (const word of ['posts', 'invitations', 'policy', 'constraint', 'relation', 'communities_slug_key', 'base/16384']) {
        assert.ok(!json.includes(word), `${json} leaks "${word}"`);
      }
    }
  });

  test('messages written for users by our database functions are kept', () => {
    assert.equal(fromDbError({ code: '23505', message: 'you are already a member of this community' }).message, 'You are already a member of this community');
    assert.equal(fromDbError({ code: '22023', message: 'this invitation has expired' }).message, 'This invitation has expired');
  });

  test('rate limits carry retryAfterSeconds', () => {
    assert.deepEqual(fromDbError({ code: '53400', message: 'x', hint: 'retry_after_seconds=42' }).details, { retryAfterSeconds: 42 });
  });

  test('the original error is not serialised', () => {
    const error = fromDbError({ code: 'XX000', message: 'secret internals' });
    assert.ok(!JSON.stringify(error).includes('secret internals'));
    assert.deepEqual(Object.keys(error.toJSON()), ['code', 'message', 'details']);
  });

  test('unknown throwables become SERVER_ERROR', () => {
    assert.equal(toServiceError(new TypeError('x is undefined')).code, ErrorCode.ServerError);
    assert.equal(toServiceError('boom').code, ErrorCode.ServerError);
  });
});

describe('validation', () => {
  test('uuids', async () => {
    assert.equal(v.uuid('AAAAAAAA-0000-4000-8000-000000000001', 'id'), 'aaaaaaaa-0000-4000-8000-000000000001');
    for (const bad of ['', 'x', '1', "' or 1=1 --", 42, null, undefined, 'aaaaaaaa-0000-4000-8000-00000000000g']) {
      await throwsWith(() => v.uuid(bad, 'id'), ErrorCode.Validation, 'id');
    }
  });

  test('text: required, trimmed, length in characters, control characters', async () => {
    assert.equal(v.text('  hi  ', 'body', { max: 5 }), 'hi');
    assert.equal(v.text('😀😀', 'body', { max: 2 }), '😀😀', 'length counts characters, not UTF-16 units');
    await throwsWith(() => v.text('   ', 'body', { max: 5 }), ErrorCode.Validation, 'body');
    await throwsWith(() => v.text('toolong', 'body', { max: 5 }), ErrorCode.Validation, 'body');
    await throwsWith(() => v.text('a\u0000b', 'body', { max: 5 }), ErrorCode.Validation, 'body');
    await throwsWith(() => v.text(123, 'body', { max: 5 }), ErrorCode.Validation, 'body');
    assert.equal(v.text('line\nbreak', 'body', { max: 20 }), 'line\nbreak');
  });

  test('enums, integers, booleans, enum lists', async () => {
    assert.equal(v.oneOf('info', 'severity', ['info', 'urgent'] as const), 'info');
    await throwsWith(() => v.oneOf('INFO', 'severity', ['info'] as const), ErrorCode.Validation, 'severity');
    await throwsWith(() => v.int(1.5, 'capacity', 1, 10), ErrorCode.Validation, 'capacity');
    await throwsWith(() => v.int(0, 'capacity', 1, 10), ErrorCode.Validation, 'capacity');
    await throwsWith(() => v.bool('true', 'flag'), ErrorCode.Validation, 'flag');
    assert.deepEqual(v.enumList(['a', 'a'], 's', ['a', 'b'] as const), ['a']);
    await throwsWith(() => v.enumList('a', 's', ['a'] as const), ErrorCode.Validation, 's');
  });

  test('dates need an explicit time zone', async () => {
    assert.equal(v.dateTime('2030-01-02T03:04:05+02:00', 'startsAt'), '2030-01-02T01:04:05.000Z');
    assert.equal(v.dateTime(new Date('2030-01-01T00:00:00Z'), 'startsAt'), '2030-01-01T00:00:00.000Z');
    for (const bad of ['2030-01-02', '2030-01-02T03:04:05', 'tomorrow', '2030-13-45T00:00:00Z', 1700000000]) {
      await throwsWith(() => v.dateTime(bad, 'startsAt'), ErrorCode.Validation, 'startsAt');
    }
  });

  test('https URLs only', async () => {
    assert.equal(v.httpsUrl('https://cdn.example/a.png', 'avatarUrl'), 'https://cdn.example/a.png');
    for (const bad of ['http://x.example/a.png', 'javascript:alert(1)', 'data:image/png;base64,xx', 'not a url']) {
      await throwsWith(() => v.httpsUrl(bad, 'avatarUrl'), ErrorCode.Validation, 'avatarUrl');
    }
  });

  test('mass assignment: unknown keys are rejected, not ignored', async () => {
    await throwsWith(() => v.only({ body: 'x', author_user_id: 'someone' }, 'input', ['body']), ErrorCode.Validation, 'author_user_id');
    await throwsWith(() => v.only([], 'input', ['body']), ErrorCode.Validation, 'input');
    await throwsWith(() => v.nonEmptyPatch({ a: undefined }, 'patch'), ErrorCode.Validation, 'patch');
  });

  test('json objects are size-limited', async () => {
    assert.deepEqual(v.jsonObject({ a: 1 }, 'settings', 100), { a: 1 });
    await throwsWith(() => v.jsonObject({ a: 'x'.repeat(200) }, 'settings', 100), ErrorCode.Validation, 'settings');
    await throwsWith(() => v.jsonObject([1], 'settings', 100), ErrorCode.Validation, 'settings');
  });
});

describe('pagination', () => {
  test('page size defaults and bounds', async () => {
    assert.equal(pageSize(undefined), 20);
    assert.equal(pageSize(MAX_PAGE_SIZE), MAX_PAGE_SIZE);
    for (const bad of [0, -1, MAX_PAGE_SIZE + 1, 2.5, '10', 1e9]) {
      await throwsWith(() => pageSize(bad), ErrorCode.Validation, 'limit');
    }
  });

  test('cursors round-trip', () => {
    const values = ['2026-10-11T22:39:25.123456+00:00', 'aaaaaaaa-0000-4000-8000-000000000001'];
    assert.deepEqual(decodeCursor(encodeCursor(values), ['timestamp', 'uuid']), values);
    assert.deepEqual(decodeCursor(encodeCursor([4, '2026-10-11T22:39:25Z', 'aaaaaaaa-0000-4000-8000-000000000001']), ['int', 'timestamp', 'uuid'])?.[0], 4);
    assert.equal(decodeCursor(undefined, ['uuid']), null);
  });

  test('tampered cursors are rejected before any query', async () => {
    const tampered = [
      'not base64!',
      encodeCursor(['2026-01-01T00:00:00Z']), // wrong arity
      encodeCursor(['2026-01-01T00:00:00Z,id.gt.0', 'aaaaaaaa-0000-4000-8000-000000000001']), // filter injection
      encodeCursor(['1 Jan 2026, 10:00', 'aaaaaaaa-0000-4000-8000-000000000001']), // Date.parse-able but not ISO
      encodeCursor(['2026-01-01T00:00:00Z', "x') or true --"]),
      Buffer.from('{"a":1}').toString('base64url'),
      'A'.repeat(600),
    ];
    for (const cursor of tampered) {
      await throwsWith(() => decodeCursor(cursor, ['timestamp', 'uuid']), ErrorCode.Validation, 'cursor');
    }
  });

  test('a next cursor only when the page is full', () => {
    const rows = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', created_at: '2026-01-01T00:00:00Z' }];
    assert.equal(toPage(rows, 2, (r) => [r.created_at, r.id]).nextCursor, null);
    assert.ok(toPage(rows, 1, (r) => [r.created_at, r.id]).nextCursor);
  });
});

describe('logging', () => {
  test('sensitive keys and token-like values are redacted at any depth', () => {
    const out = JSON.stringify(redact({
      password: 'hunter2',
      refreshToken: 'abc',
      nested: { authorization: 'Bearer abc.def', phone: '+1 555', email: 'a@b.example', note: 'kept' },
      // A JWT-shaped string, assembled at runtime so the repository secret scan stays meaningful.
      message: `token ${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'sig'].join('.')} and invite ci_${'a'.repeat(64)}`,
      card: '4242 4242 4242 4242',
      shipping: 'kept too',
    }));
    for (const secret of ['hunter2', 'abc.def', '+1 555', 'a@b.example', 'eyJhbGci', 'ci_aaaa', '4242']) {
      assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
    }
    assert.ok(out.includes('kept') && out.includes('kept too'));
  });

  test('a throwing log sink never breaks the caller', () => {
    const logger = safeLogger({ log() { throw new Error('sink down'); } });
    assert.doesNotThrow(() => logger.log('error', 'x', { a: 1 }));
  });

  test('loggers receive redacted fields only', () => {
    const seen: LogFields[] = [];
    safeLogger({ log: (_l, _e, f) => { if (f) seen.push(f); } }).log('info', 'x', { token: 'ci_' + 'b'.repeat(64) });
    assert.deepEqual(seen, [{ token: '[redacted]' }]);
  });
});

describe('invitation tokens', () => {
  const token = 'ci_' + 'c'.repeat(64);
  test('raw tokens and links are accepted', () => {
    assert.equal(parseInvitationToken(token), token);
    assert.equal(parseInvitationToken(`communione://join?token=${token}`), token);
    assert.equal(parseInvitationToken(`https://app.example/join?x=1&token=${token}#frag`), token);
  });
  test('anything else is rejected without a database call', async () => {
    for (const bad of ['', 'ci_123', `${token}x`, 'https://app.example/join?token=%E0%A4%A', "ci_' or 1=1"]) {
      await throwsWith(() => parseInvitationToken(bad), ErrorCode.Validation, 'token');
    }
  });
});

describe('authentication fast path', () => {
  // No server is contacted: getSession() is local and there is no session.
  const services = createServices(createClient('http://127.0.0.1:1', 'anon-key-placeholder', {
    auth: { persistSession: false, autoRefreshToken: false },
  }));

  test('protected operations refuse without a session', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    await rejectsWith(services.communities.get(id), ErrorCode.Unauthenticated);
    await rejectsWith(services.posts.create({ communityId: id, body: 'x' }), ErrorCode.Unauthenticated);
    await rejectsWith(services.notifications.list(), ErrorCode.Unauthenticated);
    await rejectsWith(services.auth.deleteMyAccount(), ErrorCode.Unauthenticated);
  });
});
