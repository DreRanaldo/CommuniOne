import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { AppProviders } from '@/AppProviders';
import { createDependencies } from '@/lib/dependencies';
import { RootNavigator } from '@/navigation';
import { ThemeProvider } from '@/theme';
import { fakeLinks, fakeMedia, fakeSupabase, type FakeOptions } from './fakeSupabase';

/** Renders the whole navigation tree with a fake backend. */
export async function renderApp(options: FakeOptions & { initialURL?: string } = {}) {
  const fake = fakeSupabase(options);
  const links = fakeLinks(options.initialURL ?? null);
  const media = fakeMedia();
  const dependencies = createDependencies(fake.client, links.source, media.picker);
  const view = await render(
    <AppProviders dependencies={dependencies}>
      <RootNavigator />
    </AppProviders>,
  );
  return { ...fake, links, media, dependencies, view };
}

/** Renders a component inside the theme only (design-system tests). */
export function renderThemed(element: ReactElement, scheme: 'light' | 'dark' = 'light') {
  return render(<ThemeProvider scheme={scheme}>{element}</ThemeProvider>);
}
