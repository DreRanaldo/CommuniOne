import type { Document, Folder } from '@communione/services';
import { Pressable, View } from 'react-native';
import { Icon, Text } from '@/components';
import { makeStyles } from '@/theme';
import { formatDate } from '@/utils/format';
import { fileKind, formatSize } from './documentRules';

/** A document in a list: its type, name, size and date; restricted and archived ones say so. */
export function DocumentItem({ doc, onPress }: { doc: Document; onPress(): void }) {
  const styles = useStyles();
  const kind = fileKind(doc.file_extension);
  const facts = [kind.label, formatSize(doc.file_size), formatDate(doc.uploaded_at ?? doc.created_at)];
  const badges = [
    doc.visibility === 'managers' ? 'Managers only' : null,
    doc.status === 'archived' ? 'Archived' : null,
  ].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[`Document: ${doc.name}`, ...badges, facts.join(', ')].join('. ')}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`document-${doc.id}`}
    >
      <Icon name={kind.icon} size={26} color="primary" />
      <View style={styles.flex}>
        <Text variant="label" numberOfLines={2}>
          {doc.name}
        </Text>
        <Text variant="caption" tone="muted">
          {[...badges, ...facts].join(' · ')}
        </Text>
      </View>
      <Icon name="chevron-forward" size={18} color="textMuted" />
    </Pressable>
  );
}

/** A folder: opens its documents. */
export function FolderItem({ folder, onPress }: { folder: Folder; onPress(): void }) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Folder: ${folder.name}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`folder-${folder.id}`}
    >
      <Icon name="folder-outline" size={26} color="primary" />
      <Text variant="label" style={styles.flex} numberOfLines={1}>
        {folder.name}
      </Text>
      <Icon name="chevron-forward" size={18} color="textMuted" />
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    minHeight: t.touchTarget,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
    backgroundColor: t.colors.background,
  },
  pressed: { backgroundColor: t.colors.surfaceMuted },
  flex: { flex: 1, gap: 2 },
}));
