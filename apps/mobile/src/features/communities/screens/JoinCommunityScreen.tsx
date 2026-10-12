import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { EmptyState, Screen } from '@/components';
import type { RootStackParamList } from '@/types/navigation';

/**
 * Modal opened by communione://join?token=… or the "Join" buttons. Redeeming
 * (services.invitations.redeem) is built in the invitations UI stage. The
 * token is never displayed or logged: it works like a password.
 */
export function JoinCommunityScreen({ route }: NativeStackScreenProps<RootStackParamList, 'JoinCommunity'>) {
  const hasToken = !!route.params?.token;
  return (
    <Screen scroll={false} testID="join-community-screen">
      <EmptyState
        icon="enter-outline"
        title={hasToken ? 'Invitation received' : 'Join a community'}
        message="Joining with an invitation arrives in a later stage."
      />
    </Screen>
  );
}
