// Display rules for the mobile admin tools (RN-16). Every rule here is a
// HINT built from the user's permission keys in the current community
// (my_community_permissions), never from role names. The database decides
// every action: RLS, private.enforce_membership_update (approve / suspend,
// and the "cover" rule), the membership_roles anti-escalation policies and
// the SECURITY DEFINER invitation functions.
import { ErrorCode, isServiceError, type MembershipStatus } from '@communione/services';
import type { IconName } from '@/components';
import { errorMessage } from '@/utils/errors';
import { formatDate } from '@/utils/format';

type Can = (key: string) => boolean;

export type AdminRoute =
  | 'AdminMembers'
  | 'Invitations'
  | 'AnnouncementEditor'
  | 'AlertEditor'
  | 'Events'
  | 'Documents'
  | 'Moderation'
  | 'EditCommunity';

export interface AdminTool {
  key: string;
  group: 'People' | 'Content' | 'Moderation' | 'Community';
  title: string;
  detail: string;
  icon: IconName;
  route: AdminRoute;
}

/** Permissions that let someone act on other people's memberships. */
const MEMBER_MANAGEMENT = ['members.approve', 'members.suspend', 'members.remove', 'roles.manage'];

export const canManageMembers = (can: Can) => MEMBER_MANAGEMENT.some((key) => can(key));

/** The tools this user gets, in display order. Empty for ordinary members. */
export function adminTools(can: Can): AdminTool[] {
  const tools: (AdminTool & { show: boolean })[] = [
    {
      key: 'members',
      group: 'People',
      title: 'Members and requests',
      detail: 'Approve, suspend, remove and give roles',
      icon: 'people-outline',
      route: 'AdminMembers',
      show: canManageMembers(can),
    },
    {
      key: 'invite',
      group: 'People',
      title: 'Invite members',
      detail: 'Invitation codes and links',
      icon: 'person-add-outline',
      route: 'Invitations',
      show: can('members.invite'),
    },
    {
      key: 'announcement',
      group: 'Content',
      title: 'New announcement',
      detail: 'Official news for everyone',
      icon: 'megaphone-outline',
      route: 'AnnouncementEditor',
      show: can('announcements.create'),
    },
    {
      key: 'alert',
      group: 'Content',
      title: 'New alert',
      detail: 'Safety and urgent information',
      icon: 'warning-outline',
      route: 'AlertEditor',
      show: can('alerts.create'),
    },
    {
      key: 'events',
      group: 'Content',
      title: 'Manage events',
      detail: 'Create, edit, cancel and drafts',
      icon: 'calendar-outline',
      route: 'Events',
      show: can('events.create') || can('events.manage'),
    },
    {
      key: 'documents',
      group: 'Content',
      title: 'Manage documents',
      detail: 'Upload, rename, archive and delete',
      icon: 'folder-open-outline',
      route: 'Documents',
      show: can('documents.upload') || can('documents.manage'),
    },
    {
      key: 'moderation',
      group: 'Moderation',
      title: 'Hidden and deleted posts',
      detail: 'Review and restore posts',
      icon: 'eye-off-outline',
      route: 'Moderation',
      show: can('posts.moderate'),
    },
    {
      key: 'profile',
      group: 'Community',
      title: 'Community profile',
      detail: 'Name, description, logo and cover',
      icon: 'create-outline',
      route: 'EditCommunity',
      show: can('community.update'),
    },
  ];
  return tools.filter((t) => t.show).map(({ show: _show, ...tool }) => tool);
}

export const hasAdminTools = (can: Can) => adminTools(can).length > 0;

/** Membership lists an admin may open (RLS: other statuses need a management permission). */
export function memberTabs(can: Can): { status: MembershipStatus; label: string }[] {
  return [
    { status: 'active' as const, label: 'Active', show: can('members.view') },
    { status: 'pending' as const, label: 'Requests', show: can('members.approve') },
    {
      status: 'suspended' as const,
      label: 'Suspended',
      show: can('members.suspend') || can('members.remove'),
    },
  ]
    .filter((t) => t.show)
    .map(({ status, label }) => ({ status, label }));
}

export type MemberAction = 'approve' | 'reject' | 'suspend' | 'reinstate' | 'remove';

/** Actions on someone else's membership, from its status (the trigger's transitions). Never on yourself. */
export function memberActions(member: { status: string; isMe: boolean }, can: Can): MemberAction[] {
  if (member.isMe) return [];
  const actions: MemberAction[] = [];
  if (member.status === 'pending' && can('members.approve')) actions.push('approve', 'reject');
  if (member.status === 'active' && can('members.suspend')) actions.push('suspend');
  if (member.status === 'suspended' && can('members.suspend')) actions.push('reinstate');
  if (['pending', 'active', 'suspended'].includes(member.status) && can('members.remove'))
    actions.push('remove');
  return actions;
}

export const ACTION_LABELS: Record<MemberAction, string> = {
  approve: 'Approve',
  reject: 'Decline',
  suspend: 'Suspend',
  reinstate: 'Reinstate',
  remove: 'Remove from community',
};

export const ACTION_DONE: Record<MemberAction, string> = {
  approve: 'Approved. They are now a member.',
  reject: 'Request declined.',
  suspend: 'Suspended. They can no longer see the community.',
  reinstate: 'Reinstated. They can see the community again.',
  remove: 'Removed from the community.',
};

/** Actions that need a confirmation first. */
export const CONFIRM: Partial<Record<MemberAction, (name: string, community: string) => string>> = {
  suspend: (name, community) =>
    `Suspend ${name}? They lose access to ${community} at once, until reinstated. Their roles are kept.`,
  remove: (name, community) =>
    `Remove ${name} from ${community}? Their roles are removed. They can only come back with a new invitation.`,
  reject: (name) => `Decline ${name}'s request to join?`,
};

/** Server refusals explained in plain words. */
export function memberActionError(error: unknown): string {
  if (isServiceError(error)) {
    if (error.code === ErrorCode.Forbidden)
      return "You can't do this for this member. You may lack the permission, or they hold permissions you don't have (for example an Owner).";
    if (error.code === ErrorCode.NotFound) return 'This member is no longer in the community.';
    if (/invalid membership status transition/i.test(error.message))
      return 'This membership has changed meanwhile. Go back and open it again.';
  }
  return errorMessage(error);
}

export function roleError(error: unknown): string {
  if (isServiceError(error) && (error.code === ErrorCode.Forbidden || error.code === ErrorCode.NotFound))
    return 'You can only give or take roles whose permissions you hold yourself, and never your own.';
  if (isServiceError(error) && error.code === ErrorCode.Conflict) return 'They already have this role.';
  return errorMessage(error);
}

export const EXPIRY_CHOICES = [
  { value: '1 day', label: '1 day' },
  { value: '7 days', label: '7 days' },
  { value: '30 days', label: '30 days' },
] as const;

export const USES_CHOICES = [
  { value: 1, label: 'One person' },
  { value: 10, label: 'Up to 10' },
  { value: null, label: 'No limit' },
] as const;

/** The link people open to join (the app's join screen reads the token from it). */
export const invitationLink = (token: string) => `communione://join?token=${encodeURIComponent(token)}`;

/** "Expires 12 Oct 2026 · Used 2 of 10" */
export function invitationLine(inv: {
  status: string;
  expiresAt: string;
  useCount: number;
  maxUses: number | null;
}): string {
  const uses = inv.maxUses === null ? `Used ${inv.useCount}` : `Used ${inv.useCount} of ${inv.maxUses}`;
  const state =
    inv.status === 'revoked'
      ? 'Revoked'
      : inv.status === 'expired'
        ? 'Expired'
        : `Expires ${formatDate(inv.expiresAt)}`;
  return `${state} · ${uses}`;
}
