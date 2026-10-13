import type { DirectoryMember } from '@communione/services';

/** The name to show (a member without any name is still listed). */
export const memberName = (m: Pick<DirectoryMember, 'displayName'>) => m.displayName?.trim() || 'Member';

/** "Owner · Admin" (null when roles are not visible to the caller). */
export const roleLine = (roles: string[] | null) => (roles && roles.length > 0 ? roles.join(' · ') : null);

/** "Joined March 2024". */
export const joinedLine = (iso: string | null) =>
  iso ? `Joined ${new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}` : null;
