import type { ActiveAlert } from '@communione/services';
import { View } from 'react-native';
import { Icon, Text, type IconName } from '@/components';
import { makeStyles, useTheme } from '@/theme';
import { formatDateTime } from '@/utils/format';

const SEVERITY: Record<string, { label: string; icon: IconName }> = {
  emergency: { label: 'Emergency', icon: 'alert-circle' },
  urgent: { label: 'Urgent', icon: 'warning' },
  warning: { label: 'Warning', icon: 'warning-outline' },
  info: { label: 'Information', icon: 'information-circle-outline' },
};

/** An active alert, coloured by severity. Emergencies are announced to screen readers. */
export function AlertCard({ alert, timeZone }: { alert: ActiveAlert; timeZone?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const severity = SEVERITY[alert.severity] ?? SEVERITY.info!;
  const color = colors.severity[alert.severity as keyof typeof colors.severity] ?? colors.severity.info;
  const pressing = alert.severity === 'emergency' || alert.severity === 'urgent';
  return (
    <View
      style={[styles.card, { borderLeftColor: color }, pressing && { borderColor: color }]}
      accessible
      accessibilityRole={pressing ? 'alert' : undefined}
      accessibilityLabel={`${severity.label} alert: ${alert.title}. ${alert.body}`}
      testID={`alert-${alert.id}`}
    >
      <View style={styles.row}>
        <Icon name={severity.icon} color={color} size={20} />
        <Text variant="caption" style={[styles.label, { color }]}>
          {severity.label.toUpperCase()}
        </Text>
        <Text variant="caption" tone="muted">
          {formatDateTime(alert.published_at, timeZone)}
        </Text>
      </View>
      <Text variant="bodyStrong">{alert.title}</Text>
      <Text numberOfLines={4}>{alert.body}</Text>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  card: {
    gap: t.spacing.xs,
    padding: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderLeftWidth: 6,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  label: { flex: 1, fontWeight: '700' },
}));
