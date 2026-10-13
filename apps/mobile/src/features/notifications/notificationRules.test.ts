import { destinationOf } from './useOpenNotification';
import { isUnread, notificationKind, notificationTarget, TARGET_LABELS } from './notificationRules';

const ID = 'a1a1a1a1-0000-4000-8000-000000000001';
const COMMUNITY = 'cccccccc-0000-4000-8000-000000000001';
const n = (type: string, data: unknown, community_id: string | null = COMMUNITY) =>
  ({ type, data, community_id }) as Parameters<typeof notificationTarget>[0];

describe('notificationTarget', () => {
  test.each([
    ['comment', { post_id: ID, comment_id: ID }, 'post'],
    ['announcement', { announcement_id: ID }, 'announcement'],
    ['alert', { alert_id: ID }, 'alert'],
    ['event_created', { event_id: ID }, 'event'],
    ['event_updated', { event_id: ID }, 'event'],
    ['event_cancelled', { event_id: ID }, 'event'],
    ['system', { document_id: ID }, 'document'],
  ])('%s leads to its %s', (type, data, kind) => {
    expect(notificationTarget(n(type, data))).toEqual({ kind, id: ID, communityId: COMMUNITY });
  });

  test('an active membership leads to the community; others lead nowhere', () => {
    expect(notificationTarget(n('membership', { community_id: COMMUNITY, status: 'active' }))).toEqual({
      kind: 'community',
      id: COMMUNITY,
      communityId: COMMUNITY,
    });
    expect(notificationTarget(n('membership', { community_id: COMMUNITY, status: 'removed' }))).toBeNull();
  });

  test('the type decides the key: a comment never opens an alert', () => {
    expect(notificationTarget(n('comment', { alert_id: ID }))).toBeNull();
  });

  test('malformed or missing ids lead nowhere', () => {
    for (const bad of ['', 'not-a-uuid', `${ID}/../x`, "x' OR 1=1 --", 42, null, { id: ID }]) {
      expect(notificationTarget(n('announcement', { announcement_id: bad }))).toBeNull();
    }
    expect(notificationTarget(n('announcement', null))).toBeNull();
    expect(notificationTarget(n('announcement', [ID]))).toBeNull();
    expect(notificationTarget(n('system', {}))).toBeNull();
  });

  test('the community comes from the row first, then the data; malformed ones are dropped', () => {
    const other = 'cccccccc-0000-4000-8000-000000000002';
    expect(notificationTarget(n('alert', { alert_id: ID, community_id: other }))?.communityId).toBe(
      COMMUNITY,
    );
    expect(notificationTarget(n('alert', { alert_id: ID, community_id: other }, null))?.communityId).toBe(
      other,
    );
    expect(notificationTarget(n('alert', { alert_id: ID, community_id: 'x' }, null))?.communityId).toBeNull();
  });
});

describe('destinationOf', () => {
  test('each kind has its tab and screen', () => {
    const at = (kind: Parameters<typeof destinationOf>[0]['kind']) =>
      destinationOf({ kind, id: ID, communityId: COMMUNITY });
    expect(at('post')).toEqual({ tab: 'Home', screen: 'PostDetail', params: { postId: ID } });
    expect(at('announcement')).toMatchObject({ tab: 'CommunitiesTab', screen: 'AnnouncementDetail' });
    expect(at('alert')).toMatchObject({ tab: 'CommunitiesTab', screen: 'AlertDetail' });
    expect(at('event')).toMatchObject({ tab: 'CommunitiesTab', screen: 'EventDetail' });
    expect(at('document')).toMatchObject({ tab: 'CommunitiesTab', screen: 'DocumentDetail' });
    expect(at('community')).toMatchObject({ tab: 'CommunitiesTab', screen: 'CommunityHome' });
  });
});

test('kinds, labels and read state', () => {
  expect(notificationKind('event_cancelled').label).toBe('Event cancelled');
  expect(notificationKind('something_new').label).toBe('CommuniOne');
  expect(Object.keys(TARGET_LABELS)).toHaveLength(6);
  expect(isUnread({ read_at: null })).toBe(true);
  expect(isUnread({ read_at: '2026-10-13T00:00:00Z' })).toBe(false);
});
