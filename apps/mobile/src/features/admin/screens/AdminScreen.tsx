import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Pressable, View } from 'react-native';
import { EmptyState, Icon, Screen, Text } from '@/components';
import { useCommunity } from '@/features/communities/CurrentCommunityProvider';
import { useCommunityPermissions } from '@/features/communities/useCommunityPermissions';
import { makeStyles } from '@/theme';
import type { CommunityStackParamList } from '@/types/navigation';
import { adminTools, type AdminTool } from '../adminRules';

type Props = NativeStackScreenProps<CommunityStackParamList, 'Admin'>;

const GROUPS: AdminTool['group'][] = ['People', 'Content', 'Moderation', 'Community'];

/**
 * Admin tools for the current community (RN-16): the essential actions only;
 * the full dashboard is the Admin Web application. Each tool is listed only
 * with its permission (my_community_permissions), never from a role name,
 * and every screen and action behind it is authorized again by the database.
 */
export function AdminScreen({ navigation }: Props) {
  const styles = useStyles();
  const community = useCommunity();
  const permissions = useCommunityPermissions();
  const tools = adminTools(permissions.can);

  if (tools.length === 0) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="No admin tools"
        message={`You don't manage anything in ${community.name}.`}
      />
    );
  }

  return (
    <Screen testID="admin-screen">
      <Text tone="muted">
        {`Essential tools for ${community.name}. The full dashboard is in the CommuniOne admin website.`}
      </Text>
      {GROUPS.map((group) => {
        const items = tools.filter((t) => t.group === group);
        if (items.length === 0) return null;
        return (
          <View key={group} style={styles.group} testID={`admin-group-${group.toLowerCase()}`}>
            <Text variant="heading" accessibilityRole="header">
              {group}
            </Text>
            {items.map((tool) => (
              <Pressable
                key={tool.key}
                accessibilityRole="button"
                accessibilityLabel={tool.title}
                accessibilityHint={tool.detail}
                onPress={() => navigation.navigate(tool.route)}
                style={({ pressed }) => [styles.link, pressed && styles.pressed]}
                testID={`admin-tool-${tool.key}`}
              >
                <Icon name={tool.icon} size={22} color="primary" />
                <View style={styles.flex}>
                  <Text variant="bodyStrong">{tool.title}</Text>
                  <Text variant="caption" tone="muted">
                    {tool.detail}
                  </Text>
                </View>
                <Icon name="chevron-forward" size={18} color="textMuted" />
              </Pressable>
            ))}
          </View>
        );
      })}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  group: { gap: t.spacing.sm },
  flex: { flex: 1, gap: 2 },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    minHeight: 60,
    padding: t.spacing.md,
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
}));
