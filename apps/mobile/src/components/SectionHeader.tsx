import { View } from 'react-native';
import { makeStyles } from '@/theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface SectionHeaderProps {
  title: string;
  icon?: IconName;
  /** e.g. "See all" */
  action?: { title: string; onPress: () => void; accessibilityLabel?: string };
}

/** The title row of a section on a summary screen. */
export function SectionHeader({ title, icon, action }: SectionHeaderProps) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      {icon ? <Icon name={icon} color="textMuted" size={20} /> : null}
      <Text variant="heading" style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {action ? (
        <Button
          title={action.title}
          variant="ghost"
          fullWidth={false}
          onPress={action.onPress}
          accessibilityLabel={action.accessibilityLabel}
        />
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  title: { flex: 1 },
}));
