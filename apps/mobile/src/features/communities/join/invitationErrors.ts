// What to tell the user when an invitation cannot be used. The database
// answers an unknown token, a revoked one and an expired one differently
// only for a token that exists; an unknown token never reveals a community.
import { ErrorCode, isServiceError } from '@communione/services';
import { errorMessage } from '@/utils/errors';

export interface InvitationProblem {
  title: string;
  message: string;
  /** A network or server problem: trying again may work. */
  retry: boolean;
}

export function invitationProblem(error: unknown): InvitationProblem {
  if (isServiceError(error)) {
    const text = error.message;
    if (error.code === ErrorCode.NotFound) {
      return {
        title: 'Invitation not found',
        message: "This invitation code isn't valid. Check it, or ask for a new invitation.",
        retry: false,
      };
    }
    if (error.code === ErrorCode.Validation && /revoked/i.test(text)) {
      return {
        title: 'Invitation revoked',
        message: 'This invitation has been withdrawn. Ask for a new one.',
        retry: false,
      };
    }
    if (error.code === ErrorCode.Validation && /expired|maximum number of uses/i.test(text)) {
      return {
        title: 'Invitation expired',
        message: 'This invitation has expired or has already been used. Ask for a new one.',
        retry: false,
      };
    }
    if (error.code === ErrorCode.Validation && /no longer valid/i.test(text)) {
      return {
        title: 'Invitation no longer valid',
        message: 'The person who sent it can no longer invite members. Ask for a new invitation.',
        retry: false,
      };
    }
    if (error.code === ErrorCode.Forbidden && /suspended/i.test(text)) {
      return {
        title: 'Membership suspended',
        message: 'Your membership in this community is suspended. An invitation cannot lift a suspension.',
        retry: false,
      };
    }
    if (error.code === ErrorCode.RateLimited) {
      return { title: 'Too many attempts', message: errorMessage(error), retry: false };
    }
  }
  return { title: "Couldn't check the invitation", message: errorMessage(error), retry: true };
}
