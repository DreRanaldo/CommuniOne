import type { DirectoryMember } from '@communione/services';
import { Pressable, View } from 'react-native';
import { Avatar, Icon, Text } from '@/components';
import { makeStyles } from '@/theme';
import { joinedLine, memberName, roleLine } from './memberRules';

/** One person in the directory: picture, name, roles (when visible) and when they joined. */
export function MemberItem({ member, onPress }: { member: DirectoryMember; onPress(): void }) {
  const styles = useStyles();
  const name = memberName(member);
  const roles = roleLine(member.roles);
  const joined = joinedLine(member.joinedAt);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[name, member.isMe ? 'You' : null, roles, joined].filter(Boolean).join('. ')}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`member-${member.userId}`}
    >
      <Avatar uri={member.avatarUrl} name={name} size={48} label="" />
      <View style={styles.text}>
        <View style={styles.nameRow}>
          <Text variant="bodyStrong" numberOfLines={1} style={styles.shrink}>
            {name}
          </Text>
          {member.isMe ? (
            <View style={styles.you}>
              <Text variant="caption" tone="primary">
                You
              </Text>
            </View>
          ) : null}
        </View>
        {roles || joined ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {[roles, joined].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-forward" size={18} color="textMuted" />
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    minHeight: 64,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
    backgroundColor: t.colors.background,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
  text: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  shrink: { flexShrink: 1 },
  you: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: 1,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.primarySoft,
  },
}));
