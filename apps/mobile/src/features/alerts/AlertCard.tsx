import { Pressable, View } from 'react-native';
import { Icon, Text } from '@/components';
import { makeStyles, useTheme } from '@/theme';
import { alertDates, alertState, SEVERITY_INFO, severityOf, statusBadge, type AlertLike } from './alertRules';

export interface AlertCardProps {
  alert: AlertLike & { id: string; title: string; body: string };
  onPress?: () => void;
  /** Fewer lines (community home). */
  compact?: boolean;
  /** The community's time zone for dates. */
  timeZone?: string;
}

/**
 * The severity marker: icon + uppercase label (never colour alone). On an
 * emergency card it is drawn in the card's inverse text colour.
 */
export function SeverityBadge({ severity, inverse }: { severity: string; inverse?: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const level = severityOf(severity);
  const info = SEVERITY_INFO[level];
  const color = inverse ? colors.textInverse : colors.severity[level];
  return (
    <View style={styles.severity} testID={`severity-${level}`}>
      <Icon name={info.icon} size={level === 'emergency' ? 24 : 20} color={color} />
      <Text variant="label" style={[styles.severityLabel, { color }]}>
        {info.label.toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * An alert in a list. Alerts look unlike posts and announcements: a severity
 * marker first, a heavy accent, no author or reactions. An active emergency
 * is a solid emergency-coloured block with inverse text, a larger icon and
 * a bold title, and is announced to screen readers.
 */
export function AlertCard({ alert: a, onPress, compact, timeZone }: AlertCardProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const level = severityOf(a.severity);
  const info = SEVERITY_INFO[level];
  const state = alertState(a);
  const live = state === 'active';
  // The full emergency treatment only while it is in force; past emergencies stay marked but calm.
  const emergency = level === 'emergency' && live;
  const pressing = live && (level === 'emergency' || level === 'urgent');
  const badge = state === 'active' ? null : statusBadge(a);
  const dates = alertDates(a, timeZone);
  const color = colors.severity[level];
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : pressing ? 'alert' : undefined}
      accessibilityLiveRegion={emergency ? 'assertive' : undefined}
      accessibilityLabel={[`${info.label} alert: ${a.title}`, badge, dates, a.body]
        .filter(Boolean)
        .join('. ')}
      accessibilityHint={onPress ? 'Opens the alert' : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.card,
        { borderLeftColor: color },
        pressing && { borderColor: color, borderWidth: 2 },
        emergency && { backgroundColor: colors.severity.emergency },
        pressed && styles.pressed,
      ]}
      testID={`alert-${a.id}`}
    >
      <View style={styles.row}>
        <SeverityBadge severity={level} inverse={emergency} />
        {badge ? (
          <View style={styles.status}>
            <Text variant="caption" tone="muted">
              {badge}
            </Text>
          </View>
        ) : null}
      </View>
      <Text variant={emergency ? 'title' : 'heading'} tone={emergency ? 'inverse' : 'default'}>
        {a.title}
      </Text>
      {dates ? (
        <Text variant="caption" tone={emergency ? 'inverse' : 'muted'}>
          {dates}
        </Text>
      ) : null}
      <Text numberOfLines={compact ? 3 : 4} tone={emergency ? 'inverse' : 'default'}>
        {a.body}
      </Text>
    </Pressable>
  );
}

const useStyles = makeStyles((t) => ({
  card: {
    gap: t.spacing.xs,
    padding: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderLeftWidth: 8,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  pressed: { opacity: 0.85 },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  severity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  severityLabel: { fontWeight: '800', letterSpacing: 1 },
  status: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: t.spacing.xxs,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
}));
