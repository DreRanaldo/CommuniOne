import { ErrorCode, ServiceError } from '@communione/services';
import { errorField, errorMessage } from './errors';

describe('error presentation', () => {
  test('service errors show their safe message', () => {
    expect(errorMessage(new ServiceError(ErrorCode.Forbidden))).toBe(
      'You do not have permission to do that.',
    );
  });

  test('rate limits say when to retry', () => {
    const error = new ServiceError(ErrorCode.RateLimited, undefined, { retryAfterSeconds: 125 });
    expect(errorMessage(error)).toMatch(/about 3 minutes/);
  });

  test('anything else gets a generic message (no internals)', () => {
    expect(errorMessage(new Error('relation "secret" does not exist'))).toBe(
      'Something went wrong. Try again later.',
    );
    expect(errorMessage('boom')).toBe('Something went wrong. Try again later.');
  });

  test('validation errors expose the field', () => {
    expect(errorField(new ServiceError(ErrorCode.Validation, 'bad', { field: 'email' }))).toBe('email');
    expect(errorField(new ServiceError(ErrorCode.Forbidden))).toBeUndefined();
  });
});
