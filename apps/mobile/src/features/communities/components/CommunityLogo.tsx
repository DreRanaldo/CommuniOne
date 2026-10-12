import { Avatar } from '@/components';

/** A community's logo (https URLs only), or its initials. */
export function CommunityLogo({
  name,
  logoUrl,
  size = 48,
}: {
  name: string;
  logoUrl: string | null;
  size?: number;
}) {
  const uri = logoUrl && logoUrl.startsWith('https://') ? logoUrl : null;
  return <Avatar uri={uri} name={name} size={size} label={`${name} logo`} testID="community-logo" />;
}
