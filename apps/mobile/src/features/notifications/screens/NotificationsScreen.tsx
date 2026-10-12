import { EmptyState, Screen } from '@/components';

/** Inbox (services.notifications) is built in the notifications UI stage. */
export function NotificationsScreen() {
  return (
    <Screen scroll={false} testID="notifications-screen">
      <EmptyState
        icon="notifications-outline"
        title="No notifications"
        message="Your inbox arrives in a later stage."
      />
    </Screen>
  );
}
