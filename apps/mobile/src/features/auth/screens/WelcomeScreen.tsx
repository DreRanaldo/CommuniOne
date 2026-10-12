import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { View } from 'react-native';
import { BrandLogo, Button, Screen, Text } from '@/components';
import { TAGLINE } from '@/constants/app';
import { makeStyles } from '@/theme';
import type { AuthStackParamList } from '@/types/navigation';
import { AuthNoticeBanner } from '../components/AuthNoticeBanner';

export function WelcomeScreen({ navigation }: NativeStackScreenProps<AuthStackParamList, 'Welcome'>) {
  const styles = useStyles();
  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} testID="welcome-screen">
      <AuthNoticeBanner />
      <View style={styles.hero}>
        <BrandLogo size={120} testID="brand-logo" />
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
  actions: { gap: t.spacing.md },
}));
