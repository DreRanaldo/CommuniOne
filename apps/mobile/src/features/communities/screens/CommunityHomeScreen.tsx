import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { View } from 'react-native';
import { Card, Icon, Screen, Text, type IconName } from '@/components';
import { AuthNoticeBanner } from '@/features/auth/components/AuthNoticeBanner';
import { makeStyles } from '@/theme';
import type { CommunitySection, CommunityStackParamList } from '@/types/navigation';
import { CommunityLogo } from '../components/CommunityLogo';
import { CommunityNoticeBanner } from '../components/CommunityNoticeBanner';
import { useCommunity } from '../CurrentCommunityProvider';
import { roleLabel, typeLabel } from '../selection';

const SECTIONS: { section: CommunitySection; title: string; icon: IconName }[] = [
  { section: 'feed', title: 'Feed', icon: 'chatbubbles-outline' },
  { section: 'announcements', title: 'Announcements', icon: 'megaphone-outline' },
  { section: 'alerts', title: 'Alerts', icon: 'warning-outline' },
  { section: 'events', title: 'Events', icon: 'calendar-outline' },
  { section: 'documents', title: 'Documents', icon: 'document-text-outline' },
  { section: 'members', title: 'Members', icon: 'people-outline' },
];

/** Hub of the current community. Sections are placeholders until their feature stages. */
export function CommunityHomeScreen({
  navigation,
}: NativeStackScreenProps<CommunityStackParamList, 'CommunityHome'>) {
  const styles = useStyles();
  const community = useCommunity();
  const role = roleLabel(community);
  return (
    <Screen testID="community-home-screen">
      <AuthNoticeBanner only={['emailConfirmed', 'passwordUpdated', 'linkError']} />
      <CommunityNoticeBanner />
      <View style={styles.header}>
        <CommunityLogo community={community} size={64} />
        <View style={styles.headerText}>
          <Text variant="title">{community.name}</Text>
          <Text tone="muted">{[typeLabel(community.community_type), role].filter(Boolean).join(' · ')}</Text>
        </View>
      </View>
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

const useStyles = makeStyles((t) => ({
  header: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  headerText: { flex: 1, gap: t.spacing.xxs },
}));
