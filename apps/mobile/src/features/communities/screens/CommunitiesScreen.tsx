import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Screen } from '@/components';
import type { RootStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { CommunityList } from '../components/CommunityList';
import { useCurrentCommunity } from '../CurrentCommunityProvider';

type Props = NativeStackScreenProps<RootStackParamList, 'Communities'>;

/**
 * The community switcher (modal). Opening it re-checks the user's memberships
 * with the server. communione://communities/<id> asks to switch to a
 * community: the id is accepted only if it is one of the user's own active
 * memberships (select() re-checks with the server); otherwise it is refused
 * and the current community stays as it was.
 */
export function CommunitiesScreen({ navigation, route }: Props) {
  const { refresh, select } = useCurrentCommunity();
  const [linkError, setLinkError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.replace('App', { screen: 'Home' });
  }, [navigation]);

  // The list is re-validated every time the switcher is shown.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  // A community requested by a link: validate, then switch or refuse.
  const requested = route.params?.communityId;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!requested || handled.current === requested) return;
    handled.current = requested;
    navigation.setParams({ communityId: undefined });
    select(requested).then(close, (error: unknown) => setLinkError(errorMessage(error)));
  }, [requested, select, close, navigation]);

  return (
    <Screen scroll={false} edges={['left', 'right', 'bottom']} testID="communities-screen">
      <CommunityList onSelected={close} error={linkError} />
    </Screen>
  );
}
