import { EmptyState, Screen } from '@/components';

/** The Marketplace tab: a later module (not part of the MVP). */
export function MarketplaceScreen() {
  return (
    <Screen scroll={false} testID="marketplace-screen">
      <EmptyState
        icon="storefront-outline"
        title="Marketplace is coming soon"
        message="Buying, selling and services in your community will arrive in a later version of CommuniOne."
      />
    </Screen>
  );
}
