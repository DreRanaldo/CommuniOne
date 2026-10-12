import { ErrorCode, isServiceError } from '@communione/services';

/** A message that is safe and useful to show for any thrown value. */
export function errorMessage(error: unknown): string {
  if (isServiceError(error)) {
    if (error.code === ErrorCode.RateLimited && error.details.retryAfterSeconds) {
      const minutes = Math.max(1, Math.ceil(error.details.retryAfterSeconds / 60));
      return `${error.message} Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    }
    return error.message;
  }
  return 'Something went wrong. Try again later.';
}

/** The input field a validation error refers to, if any. */
export function errorField(error: unknown): string | undefined {
  return isServiceError(error) && error.code === ErrorCode.Validation ? error.details.field : undefined;
}
