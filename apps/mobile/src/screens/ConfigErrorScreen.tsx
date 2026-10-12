import { View } from 'react-native';
import { Icon, Screen, Text } from '@/components';
import { makeStyles } from '@/theme';

/**
 * Shown instead of the app when the public configuration is missing or
 * unsafe (for example a service-role key). Lists what is wrong; never
 * displays the configured values.
 */
export function ConfigErrorScreen({ problems }: { problems: string[] }) {
  const styles = useStyles();
  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} testID="config-error-screen">
      <View style={styles.header}>
        <Icon name="settings-outline" size={40} color="danger" />
        <Text variant="title" align="center">
          App configuration problem
        </Text>
        <Text tone="muted" align="center">
          CommuniOne cannot start until its configuration is fixed. See apps/mobile/README.md.
        </Text>
      </View>
      {problems.map((problem) => (
        <Text key={problem} tone="danger">
          • {problem}
        </Text>
      ))}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  header: { alignItems: 'center', gap: t.spacing.md, marginTop: t.spacing.xxl },
}));
