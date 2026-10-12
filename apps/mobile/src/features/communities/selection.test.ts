import type { MyCommunity } from '@communione/services';
import { makeCommunity } from '@/testing/fakeSupabase';
import {
  filterCommunities,
  isSelectable,
  resolveSelection,
  roleLabel,
  typeLabel,
  unavailableReason,
} from './selection';

const c = (n: number, overrides: Record<string, unknown> = {}) =>
  makeCommunity(n, overrides) as unknown as MyCommunity;

describe('isSelectable / unavailableReason', () => {
  test.each([
    [{}, true, null],
    [{ membership_status: 'pending' }, false, 'Waiting for approval'],
    [{ membership_status: 'suspended' }, false, 'Membership suspended'],
    [{ community_status: 'archived' }, false, 'Community archived'],
    [{ community_status: 'suspended' }, false, 'Community suspended'],
    [{ membership_status: 'left' }, false, 'Unavailable'],
  ])('%j', (overrides, selectable, reason) => {
    expect(isSelectable(c(1, overrides))).toBe(selectable);
    expect(unavailableReason(c(1, overrides))).toBe(reason);
  });
});

describe('resolveSelection', () => {
  const a = c(1);
  const b = c(2);
  const pending = c(3, { membership_status: 'pending' });

  test('keeps a preferred community that is still selectable', () => {
    expect(resolveSelection([a, b], b.community_id)).toBe(b.community_id);
  });
  test('drops a preferred community the user is not a member of', () => {
    expect(resolveSelection([a, b], 'eeeeeeee-0000-4000-8000-000000000099')).toBeNull();
  });
  test('drops a preferred community that is no longer selectable', () => {
    expect(resolveSelection([a, b, pending], pending.community_id)).toBeNull();
  });
  test('falls back to the only selectable community', () => {
    expect(resolveSelection([a, pending], null)).toBe(a.community_id);
    expect(resolveSelection([a, pending], pending.community_id)).toBe(a.community_id);
  });
  test('chooses nothing when there is a real choice or nothing to choose', () => {
    expect(resolveSelection([a, b], null)).toBeNull();
    expect(resolveSelection([pending], null)).toBeNull();
    expect(resolveSelection([], null)).toBeNull();
  });
});

describe('labels', () => {
  test('type and role labels', () => {
    expect(typeLabel('residential')).toBe('Residential');
    expect(typeLabel('other')).toBe('Community');
    expect(typeLabel('unknown-type')).toBe('Community');
    expect(roleLabel(c(1, { role_names: ['Moderator', 'Owner'] }))).toBe('Moderator, Owner');
    expect(roleLabel(c(1, { role_names: [] }))).toBeNull();
  });
});

describe('filterCommunities', () => {
  const list = [
    c(1, { name: 'Maple Grove HOA', community_type: 'residential', role_names: ['Owner'] }),
    c(2, { name: 'Café Society', community_type: 'club' }),
    c(3, { name: 'St. Mark Choir', community_type: 'church' }),
  ];
  const names = (query: string) => filterCommunities(list, query).map((x) => x.name);

  test('an empty query returns everything', () => {
    expect(names('  ')).toHaveLength(3);
  });
  test('matches name, type and role, case- and accent-insensitively', () => {
    expect(names('maple')).toEqual(['Maple Grove HOA']);
    expect(names('cafe')).toEqual(['Café Society']);
    expect(names('CAFÉ')).toEqual(['Café Society']);
    expect(names('church')).toEqual(['St. Mark Choir']);
    expect(names('owner')).toEqual(['Maple Grove HOA']);
  });
  test('every word must match', () => {
    expect(names('member club')).toEqual(['Café Society']);
    expect(names('owner club')).toEqual([]);
  });
});
