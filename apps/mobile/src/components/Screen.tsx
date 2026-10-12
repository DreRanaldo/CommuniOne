import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { makeStyles } from '@/theme';

export interface ScreenProps {
  children: ReactNode;
  /** Scrollable content (default) or a fixed layout (lists manage their own scrolling). */
  scroll?: boolean;
  /** Safe-area edges to pad; headers already handle the top inside stacks. */
  edges?: Edge[];
  centered?: boolean;
  testID?: string;
}

/** Standard screen container: safe areas, background, padding and keyboard handling. */
export function Screen({
  children,
  scroll = true,
  edges = ['bottom', 'left', 'right'],
  centered,
  testID,
}: ScreenProps) {
  const styles = useStyles();
  const content = scroll ? (
    <ScrollView
      contentContainerStyle={[styles.content, centered && styles.centered]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.content, styles.fill, centered && styles.centered]}>{children}</View>
  );
  return (
    <SafeAreaView style={styles.safe} edges={edges} testID={testID}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {content}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const useStyles = makeStyles((t) => ({
  safe: { flex: 1, backgroundColor: t.colors.background },
  fill: { flex: 1 },
  content: { flexGrow: 1, padding: t.spacing.lg, gap: t.spacing.lg },
  centered: { justifyContent: 'center', alignItems: 'center' },
}));
