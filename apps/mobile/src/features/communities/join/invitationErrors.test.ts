import { ErrorCode, ServiceError } from '@communione/services';
import { invitationProblem } from './invitationErrors';

const problem = (code: ErrorCode, message?: string) => invitationProblem(new ServiceError(code, message));

describe('invitationProblem', () => {
  test('maps every refusal of the database functions', () => {
    expect(problem(ErrorCode.NotFound, 'Invalid invitation').title).toBe('Invitation not found');
    expect(problem(ErrorCode.Validation, 'This invitation has been revoked').title).toBe(
      'Invitation revoked',
    );
    expect(problem(ErrorCode.Validation, 'This invitation has expired').title).toBe('Invitation expired');
    expect(
      problem(ErrorCode.Validation, 'This invitation has reached its maximum number of uses').title,
    ).toBe('Invitation expired');
    expect(problem(ErrorCode.Validation, 'This invitation is no longer valid').title).toBe(
      'Invitation no longer valid',
    );
    expect(problem(ErrorCode.Forbidden, 'Your membership in this community is suspended').title).toBe(
      'Membership suspended',
    );
  });
  test('refusals are final; transport problems can be retried', () => {
    expect(problem(ErrorCode.NotFound).retry).toBe(false);
    expect(problem(ErrorCode.ServerError).retry).toBe(true);
    expect(invitationProblem(new Error('boom')).retry).toBe(true);
  });
  test('never echoes internal details', () => {
    expect(invitationProblem(new Error('relation at /var/lib/postgresql')).message).not.toMatch(/postgresql/);
  });
});
