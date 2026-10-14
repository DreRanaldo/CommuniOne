// What a notification is about and where it leads. The notification's data
// is NOT trusted for authorization: ids are only accepted if they are well
// formed, and every destination screen re-reads its item through the
// database (RLS), refusing what the user may not see. The community comes
// from the notification row (set by the server, immutable) and is selected
// through the server-validated community list before anything opens.
import type { Notification } from '@communione/services';
import type { IconName } from '@/components';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string | null => (typeof value === 'string' && UUID.test(value) ? value : null);

export type TargetKind =
  | 'post'
  | 'announcement'
  | 'alert'
  | 'event'
  | 'community'
  | 'document'
  | 'order'
  | 'checkout'
  | 'booking'
  | 'dispute'
  | 'earnings';

export interface NotificationTarget {
  kind: TargetKind;
  /** The item's id (for `community`, the community id). */
  id: string;
  /** The community the item belongs to (from the notification row), if any. */
  communityId: string | null;
}

export const TARGET_LABELS: Record<TargetKind, string> = {
  post: 'Open the post',
  announcement: 'Open the announcement',
  alert: 'Open the alert',
  event: 'Open the event',
  community: 'Open the community',
  document: 'Open the document',
  order: 'Open the order',
  checkout: 'Open the payment',
  booking: 'Open the booking',
  dispute: 'Open the dispute',
  earnings: 'Open your earnings',
};

type Data = Record<string, unknown>;

/** The destination of a notification, or null when it has none (e.g. a system message). */
export function notificationTarget(
  n: Pick<Notification, 'type' | 'data' | 'community_id'>,
): NotificationTarget | null {
  const data = (n.data && typeof n.data === 'object' && !Array.isArray(n.data) ? n.data : {}) as Data;
  const communityId = id(n.community_id) ?? id(data.community_id);
  const make = (kind: TargetKind, value: unknown): NotificationTarget | null => {
    const itemId = id(value);
    return itemId ? { kind, id: itemId, communityId } : null;
  };
  switch (n.type) {
    case 'comment':
      return make('post', data.post_id);
    case 'announcement':
      return make('announcement', data.announcement_id);
    case 'alert':
      return make('alert', data.alert_id);
    case 'event_created':
    case 'event_updated':
    case 'event_cancelled':
      return make('event', data.event_id);
    // Marketplace (Stages C-K). Amounts and payment details are never in the data.
    case 'order':
    case 'delivery':
      return make('order', data.order_id);
    case 'refund':
      return make('order', data.order_id) ?? make('booking', data.booking_id);
    case 'payment':
      return (
        make('checkout', data.checkout_id) ??
        make('booking', data.booking_id) ??
        (id(data.payout_id) && communityId
          ? { kind: 'earnings', id: id(data.payout_id)!, communityId }
          : null)
      );
    case 'booking':
      return make('booking', data.booking_id);
    case 'dispute':
      return make('dispute', data.dispute_id);
    case 'membership':
      // Only an active membership leads into the community.
      return data.status === 'active' && communityId
        ? { kind: 'community', id: communityId, communityId }
        : null;
    default:
      // Other types (system, future ones): the first recognised link, if any.
      return (
        make('post', data.post_id) ??
        make('announcement', data.announcement_id) ??
        make('alert', data.alert_id) ??
        make('event', data.event_id) ??
        make('document', data.document_id) ??
        (communityId && data.community_id ? { kind: 'community', id: communityId, communityId } : null)
      );
  }
}

/** Icon and short label for a notification's type. */
export function notificationKind(type: string): { icon: IconName; label: string } {
  switch (type) {
    case 'announcement':
      return { icon: 'megaphone-outline', label: 'Announcement' };
    case 'alert':
      return { icon: 'warning-outline', label: 'Alert' };
    case 'event_created':
      return { icon: 'calendar-outline', label: 'New event' };
    case 'event_updated':
      return { icon: 'calendar-outline', label: 'Event update' };
    case 'event_cancelled':
      return { icon: 'calendar-clear-outline', label: 'Event cancelled' };
    case 'comment':
      return { icon: 'chatbubble-outline', label: 'Comment' };
    case 'membership':
      return { icon: 'people-outline', label: 'Membership' };
    case 'order':
    case 'delivery':
      return { icon: 'bag-handle-outline', label: 'Order' };
    case 'payment':
      return { icon: 'card-outline', label: 'Payment' };
    case 'refund':
      return { icon: 'cash-outline', label: 'Refund' };
    case 'booking':
      return { icon: 'calendar-outline', label: 'Booking' };
    case 'dispute':
      return { icon: 'chatbubbles-outline', label: 'Dispute' };
    default:
      return { icon: 'notifications-outline', label: 'CommuniOne' };
  }
}

export const isUnread = (n: Pick<Notification, 'read_at'>) => !n.read_at;

/** Why a destination could not be opened, in plain words. */
export const NO_ACCESS =
  "You can't open this any more. It may have been removed, or you may no longer be a member of that community.";
