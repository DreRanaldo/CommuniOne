// Rules for choosing the current community from the caller's memberships
// (services.communities.listMine → my_communities()). The list comes from the
// server and contains only the caller's own memberships; a community id from
// anywhere else (storage, a link, the UI) is used only if it is in that list.
// This decides what the app shows. The database still authorizes every request.
import type { MyCommunity } from '@communione/services';

/** A community can be entered with an active membership in an active community. */
export const isSelectable = (community: MyCommunity): boolean =>
  community.membership_status === 'active' && community.community_status === 'active';

/** Why a listed community cannot be entered (null when it can). */
export function unavailableReason(community: MyCommunity): string | null {
  if (community.membership_status === 'pending') return 'Waiting for approval';
  if (community.membership_status === 'suspended') return 'Membership suspended';
  if (community.community_status === 'archived') return 'Community archived';
  if (community.community_status === 'suspended') return 'Community suspended';
  if (!isSelectable(community)) return 'Unavailable';
  return null;
}

/**
 * The community to show, given the memberships and a preferred id (the last
 * selection). The preferred one if it is selectable; otherwise the only
 * selectable community if there is exactly one; otherwise none (the user picks).
 */
export function resolveSelection(communities: MyCommunity[], preferredId: string | null): string | null {
  const selectable = communities.filter(isSelectable);
  if (preferredId && selectable.some((c) => c.community_id === preferredId)) return preferredId;
  return selectable.length === 1 ? selectable[0]!.community_id : null;
}

const TYPE_LABELS: Record<string, string> = {
  residential: 'Residential',
  church: 'Church',
  school: 'School',
  club: 'Club',
  association: 'Association',
  organization: 'Organization',
  other: 'Community',
};

export const typeLabel = (type: string): string => TYPE_LABELS[type] ?? 'Community';

/** Role names are display labels only; nothing is authorized on them. */
export const roleLabel = (community: MyCommunity): string | null =>
  community.role_names.length > 0 ? community.role_names.join(', ') : null;

const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/**
 * Search foundation: matches every word of the query against the name, type
 * and roles, ignoring case and accents. Runs on the already-loaded list; a
 * server-side search can replace it if lists grow large.
 */
export function filterCommunities(communities: MyCommunity[], query: string): MyCommunity[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return communities;
  return communities.filter((community) => {
    const haystack = normalize(
      [community.name, typeLabel(community.community_type), ...community.role_names].join(' '),
    );
    return words.every((word) => haystack.includes(word));
  });
}
