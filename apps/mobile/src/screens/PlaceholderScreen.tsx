import { EmptyState, Screen } from '@/components';

/** Stand-in for screens planned in later stages, so navigation can be built and tested now. */
export function PlaceholderScreen() {
  return (
    <Screen scroll={false}>
      <EmptyState
        icon="construct-outline"
        title="Coming soon"
        message="This part of CommuniOne arrives in a later stage."
      />
    </Screen>
  );
}
