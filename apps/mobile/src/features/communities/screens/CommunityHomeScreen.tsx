import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Card, Icon, Screen, Text, type IconName } from '@/components';
import { useCommunity } from '@/navigation/CommunityContext';
import type { CommunitySection, CommunityStackParamList } from '@/types/navigation';

const SECTIONS: { section: CommunitySection; title: string; icon: IconName }[] = [
  { section: 'feed', title: 'Feed', icon: 'chatbubbles-outline' },
  { section: 'announcements', title: 'Announcements', icon: 'megaphone-outline' },
  { section: 'alerts', title: 'Alerts', icon: 'warning-outline' },
  { section: 'events', title: 'Events', icon: 'calendar-outline' },
  { section: 'documents', title: 'Documents', icon: 'document-text-outline' },
  { section: 'members', title: 'Members', icon: 'people-outline' },
];

/** Hub of one community. Sections are placeholders until their feature stages. */
export function CommunityHomeScreen({
  navigation,
}: NativeStackScreenProps<CommunityStackParamList, 'CommunityHome'>) {
  const { name } = useCommunity();
  return (
    <Screen testID="community-home-screen">
      <Text variant="title">{name ?? 'Community'}</Text>
      {SECTIONS.map(({ section, title, icon }) => (
        <Card
          key={section}
          accessibilityLabel={title}
          onPress={() => navigation.navigate('CommunitySection', { section })}
        >
          <Icon name={icon} color="primary" />
          <Text variant="bodyStrong">{title}</Text>
        </Card>
      ))}
    </Screen>
  );
}
