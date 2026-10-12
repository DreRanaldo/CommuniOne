import { forwardRef, useId, useState } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';
import { makeStyles, useTheme } from '@/theme';
import { Icon } from './Icon';
import { Text } from './Text';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  error?: string | null;
  hint?: string;
}

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, error, hint, onFocus, onBlur, secureTextEntry, ...rest },
  ref,
) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  // Secret fields can be revealed by the user (never by default).
  const [revealed, setRevealed] = useState(false);
  const id = useId();

  return (
    <View style={styles.container}>
      <Text variant="label" nativeID={`${id}-label`}>
        {label}
      </Text>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        accessibilityLabelledBy={`${id}-label`}
        accessibilityHint={error ?? hint}
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.primary}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        {...rest}
        secureTextEntry={secureTextEntry && !revealed}
        style={[
          styles.input,
          focused && styles.focused,
          !!error && styles.invalid,
          secureTextEntry && styles.withToggle,
        ]}
      />
      {secureTextEntry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          onPress={() => setRevealed((r) => !r)}
          style={styles.toggle}
          hitSlop={8}
        >
          <Icon name={revealed ? 'eye-off-outline' : 'eye-outline'} size={20} color="textMuted" />
        </Pressable>
      ) : null}
      {error ? (
        <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

const useStyles = makeStyles((t) => ({
  container: { gap: t.spacing.xs, alignSelf: 'stretch' },
  input: {
    minHeight: t.touchTarget,
    borderWidth: 1,
    borderColor: t.colors.border,
    borderRadius: t.radius.md,
    paddingHorizontal: t.spacing.md,
    backgroundColor: t.colors.surface,
    color: t.colors.text,
    fontSize: t.typography.body.fontSize,
  },
  focused: { borderColor: t.colors.primary },
  withToggle: { paddingRight: t.touchTarget },
  toggle: {
    position: 'absolute',
    right: 0,
    top: t.typography.label.lineHeight + t.spacing.xs,
    width: t.touchTarget,
    height: t.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  invalid: { borderColor: t.colors.danger },
}));
