import type { CommunityImages } from '@communione/services';
import { Avatar } from '@/components';
import { useServices } from '@/lib/dependencies';

/** A community's logo (uploaded file, else an external https URL), or its initials. */
export function CommunityLogo({
  community,
  size = 48,
}: {
  community: CommunityImages & { name: string };
  size?: number;
}) {
  const { communities } = useServices();
  return (
    <Avatar
      uri={communities.imageUrl(community, 'logo')}
      name={community.name}
      size={size}
      label={`${community.name} logo`}
      testID="community-logo"
    />
  );
}
