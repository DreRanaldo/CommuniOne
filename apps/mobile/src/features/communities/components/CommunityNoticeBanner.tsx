import { Banner } from '@/components';
import { useCurrentCommunity } from '../CurrentCommunityProvider';

/** "You no longer have access to …", shown wherever the user lands after losing access. */
export function CommunityNoticeBanner() {
  const { notice, clearNotice } = useCurrentCommunity();
  if (notice?.kind !== 'lostAccess') return null;
  return (
    <Banner
      title={
        notice.name ? `You no longer have access to ${notice.name}` : 'Your last community is not available'
      }
      message="It may have been archived, or your membership changed."
      onDismiss={clearNotice}
      testID="community-lost-access"
    />
  );
}
