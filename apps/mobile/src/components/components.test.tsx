import { screen, userEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { renderThemed } from '@/testing/render';
import { brand, darkTheme, lightTheme } from '@/theme';
import { BrandLogo, Button, Card, EmptyState, ErrorState, LoadingState, Text, TextField } from './index';

describe('design system', () => {
  test('Button presses, and is inert while disabled or loading', async () => {
    const user = userEvent.setup();
    const onPress = jest.fn();
    const view = await renderThemed(<Button title="Save" onPress={onPress} />);
    await user.press(screen.getByRole('button', { name: 'Save' }));
    expect(onPress).toHaveBeenCalledTimes(1);

    await view.rerender(<Button title="Save" onPress={onPress} disabled />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.press(screen.getByRole('button', { name: 'Save' }));
    expect(onPress).toHaveBeenCalledTimes(1);

    await view.rerender(<Button title="Save" onPress={onPress} loading />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeBusy();
    expect(screen.getByTestId('button-loading')).toBeOnTheScreen();
  });

  test('TextField is labelled and shows its error', async () => {
    const user = userEvent.setup();
    const onChangeText = jest.fn();
    await renderThemed(<TextField label="Email" onChangeText={onChangeText} error="Email is required." />);
    await user.type(screen.getByLabelText('Email'), 'a@b.c');
    expect(onChangeText).toHaveBeenLastCalledWith('a@b.c');
    expect(screen.getByText('Email is required.')).toBeOnTheScreen();
  });

  test('loading, error and empty states', async () => {
    const user = userEvent.setup();
    const retry = jest.fn();
    await renderThemed(
      <>
        <LoadingState label="Loading posts…" />
        <ErrorState message="Could not load." onRetry={retry} />
        <EmptyState title="Nothing here" action={{ title: 'Create', onPress: jest.fn() }} />
      </>,
    );
    expect(screen.getByLabelText('Loading posts…')).toBeOnTheScreen();
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not load\./);
    await user.press(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
    expect(screen.getByText('Nothing here')).toBeOnTheScreen();
  });

  test('Text and Card take their colours from the theme (light and dark)', async () => {
    await renderThemed(
      <Card>
        <Text>Hello</Text>
      </Card>,
      'dark',
    );
    expect(screen.getByText('Hello')).toHaveStyle({ color: darkTheme.colors.text });
    expect(darkTheme.colors.text).not.toBe(lightTheme.colors.text);
  });

  test('every interactive element meets the minimum touch target', () => {
    expect(lightTheme.touchTarget).toBeGreaterThanOrEqual(44);
  });

  test('BrandLogo: one image named CommuniOne, readable in both themes', async () => {
    const light = await renderThemed(<BrandLogo testID="logo" />);
    expect(screen.getByRole('image', { name: 'CommuniOne' })).toBeOnTheScreen();
    expect(screen.getByTestId('brand-mark')).toBeOnTheScreen();
    const lightSource = screen.getByTestId('brand-wordmark').props.source;
    await light.unmount();

    // Dark: the mark on a white tile, and the white-lettered wordmark.
    const dark = await renderThemed(<BrandLogo testID="logo" />, 'dark');
    expect(StyleSheet.flatten(screen.getByTestId('brand-mark-tile').props.style)).toMatchObject({
      backgroundColor: brand.paper,
    });
    expect(screen.getByTestId('brand-wordmark').props.source).not.toBe(lightSource);
    await dark.unmount();

    await renderThemed(<BrandLogo variant="mark" />);
    expect(screen.getByTestId('brand-mark')).toBeOnTheScreen();
    expect(screen.queryByTestId('brand-wordmark')).not.toBeOnTheScreen();
  });
});
