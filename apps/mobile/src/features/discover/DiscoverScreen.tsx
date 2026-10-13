import { useNavigation } from '@react-navigation/native';
import type { MyCommunity } from '@communione/services';
import { useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, Icon, Text } from '@/components';
import { CommunityLogo } from '@/features/communities/components/CommunityLogo';
import { useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { filterCommunities, isSelectable, roleLabel, typeLabel } from '@/features/communities/selection';
import { makeStyles, useTheme, type TintName } from '@/theme';
import { errorMessage } from '@/utils/errors';

const CARD_TINTS: TintName[] = ['blue', 'amber', 'green', 'purple', 'teal'];

/**
 * Discover: finding your communities and joining new ones. Communities are
 * private (members only, joined by invitation), so there is no public
 * directory: this screen searches the user's own communities and offers
 * joining with an invitation or starting a community.
 */
export function DiscoverScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const navigation = useNavigation();
  const { communities, current, select } = useCurrentCommunity();
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const shown = filterCommunities(communities, query);

  const open = async (community: MyCommunity) => {
    setProblem(null);
    try {
      // The server re-checks the membership before switching.
      if (community.community_id !== current?.community_id) await select(community.community_id);
      navigation.navigate('App', { screen: 'CommunitiesTab', params: { screen: 'CommunityHome' } });
    } catch (thrown) {
      setProblem(errorMessage(thrown));
    }
  };

  return (
    <SafeAreaView edges={['top']} style={styles.container} testID="discover-screen">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <Text variant="caption" style={styles.eyebrow}>
            FIND YOUR PEOPLE
          </Text>
          <Text variant="display" align="center" accessibilityRole="header">
            Discover communities
          </Text>
          <Text tone="muted" align="center">
            Connect with your neighbours, congregation, school or club. Communities are private: you join with
            an invitation from someone inside.
          </Text>
          <View style={styles.search}>
            <Icon name="search-outline" size={20} color="textMuted" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search your communities"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Search your communities"
              style={styles.input}
              autoCorrect={false}
            />
          </View>
        </View>

        <View style={styles.actions}>
          <ActionCard
            icon="enter-outline"
            tint="blue"
            title="Have an invitation?"
            detail="Join with a link or code"
            onPress={() => navigation.navigate('JoinCommunity')}
          />
          <ActionCard
            icon="add-circle-outline"
            tint="teal"
            title="Start a community"
            detail="Create a hub and invite people"
            onPress={() => navigation.navigate('CreateCommunity')}
          />
        </View>

        {problem ? <Banner tone="danger" message={problem} testID="discover-error" /> : null}

        <View>
          <Text variant="heading">Your communities</Text>
          <Text variant="caption" tone="muted">
            {communities.length === 1 ? '1 community' : `${communities.length} communities`}
          </Text>
        </View>
        {shown.length === 0 ? (
          <Text tone="muted" testID="discover-empty">
            {communities.length === 0
              ? "You haven't joined a community yet."
              : 'No community matches your search.'}
          </Text>
        ) : (
          shown.map((community, i) => {
            const tint = colors.tints[CARD_TINTS[i % CARD_TINTS.length]!];
            const isCurrent = community.community_id === current?.community_id;
            const available = isSelectable(community);
            return (
              <View
                key={community.community_id}
                style={styles.card}
                testID={`discover-${community.community_id}`}
              >
                <View style={[styles.cover, { backgroundColor: tint.bg }]}>
                  <View style={styles.logo}>
                    <CommunityLogo community={community} size={56} />
                  </View>
                </View>
                <View style={styles.body}>
                  <Text variant="caption" style={[styles.eyebrow, { color: tint.fg }]}>
                    {typeLabel(community.community_type).toUpperCase()}
                  </Text>
                  <Text variant="heading">{community.name}</Text>
                  <Text variant="caption" tone="muted">
                    {[roleLabel(community), isCurrent ? 'Current community' : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  <Button
                    title={isCurrent ? 'Open community' : 'Switch to this community'}
                    variant="secondary"
                    disabled={!available}
                    onPress={() => void open(community)}
                    accessibilityLabel={`${isCurrent ? 'Open' : 'Switch to'} ${community.name}`}
                  />
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionCard({
  icon,
  tint: tintName,
  title,
  detail,
  onPress,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  tint: TintName;
  title: string;
  detail: string;
  onPress(): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const tint = colors.tints[tintName];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={detail}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <View style={[styles.actionIcon, { backgroundColor: tint.bg }]}>
        <Icon name={icon} size={22} color={tint.fg} />
      </View>
      <Text variant="label">{title}</Text>
      <Text variant="caption" tone="muted">
        {detail}
      </Text>
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.lg, gap: t.spacing.lg },
  hero: {
    alignItems: 'center',
    gap: t.spacing.sm,
    padding: t.spacing.xl,
    borderRadius: t.radius.lg + 8,
    backgroundColor: t.colors.tints.blue.bg,
  },
  eyebrow: { color: t.colors.primary, fontWeight: '700', letterSpacing: 1.2 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    alignSelf: 'stretch',
    minHeight: 48,
    marginTop: t.spacing.sm,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  input: { flex: 1, color: t.colors.text, fontSize: t.typography.body.fontSize, minHeight: 44 },
  actions: { flexDirection: 'row', gap: t.spacing.md },
  action: {
    flex: 1,
    gap: t.spacing.xs,
    padding: t.spacing.md,
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  actionIcon: {
    width: 40,
    height: 40,
    borderRadius: t.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
  card: {
    borderRadius: t.radius.lg + 4,
    borderWidth: 1,
    borderColor: t.colors.border,
    overflow: 'hidden',
    backgroundColor: t.colors.surface,
  },
  cover: { height: 96, alignItems: 'center', justifyContent: 'center' },
  logo: { padding: 4, borderRadius: t.radius.lg, backgroundColor: t.colors.surface },
  body: { padding: t.spacing.lg, gap: t.spacing.xs },
}));
