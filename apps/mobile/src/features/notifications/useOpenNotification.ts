// Opening a notification: mark it read, make its community current (re-checked
// on the server), then go to the item. The item's own screen re-reads it from
// the database and refuses what the user may not see, so a notification can
// never grant access by itself.
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import type { Notification } from '@communione/services';
import { useCallback } from 'react';
import { useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useServices } from '@/lib/dependencies';
import { openInCommunity, type CommunityTab } from '@/navigation/openInCommunity';
import type { CommunityStackParamList, RootStackParamList } from '@/types/navigation';
import { NO_ACCESS, notificationTarget, type NotificationTarget } from './notificationRules';

type Destination = {
  [S in keyof CommunityStackParamList]: {
    tab: CommunityTab;
    screen: S;
    params: CommunityStackParamList[S];
  };
}[keyof CommunityStackParamList];

export function destinationOf(target: NotificationTarget): Destination {
  switch (target.kind) {
    case 'post':
      return { tab: 'Home', screen: 'PostDetail', params: { postId: target.id } };
    case 'announcement':
      return { tab: 'CommunitiesTab', screen: 'AnnouncementDetail', params: { announcementId: target.id } };
    case 'alert':
      return { tab: 'CommunitiesTab', screen: 'AlertDetail', params: { alertId: target.id } };
    case 'event':
      return { tab: 'CommunitiesTab', screen: 'EventDetail', params: { eventId: target.id } };
    case 'document':
      return { tab: 'CommunitiesTab', screen: 'DocumentDetail', params: { documentId: target.id } };
    case 'community':
      return { tab: 'CommunitiesTab', screen: 'CommunityHome', params: undefined };
    case 'order':
      return { tab: 'Marketplace', screen: 'OrderDetail', params: { orderId: target.id } };
    case 'checkout':
      return { tab: 'Marketplace', screen: 'Payment', params: { checkoutId: target.id } };
    case 'booking':
      return { tab: 'Marketplace', screen: 'BookingDetail', params: { bookingId: target.id } };
    case 'dispute':
      return { tab: 'Marketplace', screen: 'Dispute', params: { disputeId: target.id } };
    case 'earnings':
      return { tab: 'Marketplace', screen: 'Earnings', params: undefined };
  }
}

export type OpenResult =
  { opened: true } | { opened: false; reason: 'no-target' | 'no-access'; message?: string };

/**
 * Returns open(notification). Marks it read (best effort), and if it leads
 * somewhere, switches to its community when needed and navigates there.
 */
export function useOpenNotification() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { notifications } = useServices();
  const { current, select } = useCurrentCommunity();

  return useCallback(
    async (n: Notification): Promise<OpenResult> => {
      if (!n.read_at) await notifications.markRead(n.id).catch(() => false);
      const target = notificationTarget(n);
      if (!target) return { opened: false, reason: 'no-target' };
      if (target.communityId && target.communityId !== current?.community_id) {
        try {
          // The server decides whether this community is still the user's.
          await select(target.communityId);
        } catch {
          return { opened: false, reason: 'no-access', message: NO_ACCESS };
        }
      }
      const to = destinationOf(target);
      // Back to the existing tabs (navigate would stack a second copy of
      // them), then into the destination's tab.
      openInCommunity(navigation, to.tab, to.screen, to.params as never);
      return { opened: true };
    },
    [navigation, notifications, current?.community_id, select],
  );
}
