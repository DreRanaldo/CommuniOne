import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { View } from 'react-native';
import { Button, Icon, Screen, Text } from '@/components';
import { APP_NAME, TAGLINE } from '@/constants/app';
import { makeStyles } from '@/theme';
import type { AuthStackParamList } from '@/types/navigation';

export function WelcomeScreen({ navigation }: NativeStackScreenProps<AuthStackParamList, 'Welcome'>) {
  const styles = useStyles();
  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} testID="welcome-screen">
      <View style={styles.hero}>
        <View style={styles.badge}>
          <Icon name="people" size={40} color="onPrimary" />
        </View>
        <Text variant="display" align="center">
          {APP_NAME}
        </Text>
        <Text variant="body" tone="muted" align="center">
          {TAGLINE}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button title="Sign in" onPress={() => navigation.navigate('SignIn')} />
        <Button title="Create an account" variant="secondary" onPress={() => navigation.navigate('SignUp')} />
      </View>
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.spacing.md },
  badge: {
    width: 80,
    height: 80,
    borderRadius: t.radius.lg,
    backgroundColor: t.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: t.spacing.sm,
  },
  actions: { gap: t.spacing.md },
}));
