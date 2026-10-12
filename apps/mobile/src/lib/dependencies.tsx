// The app's dependencies (Supabase client, service layer, deep links, session
// events), provided through context so screens never import singletons and
// tests can pass fakes.
import { createContext, useContext, type ReactNode } from 'react';
import { createServices, ErrorCode, type Services } from '@communione/services';
import { expoLinkSource, type LinkSource } from './links';
import { logger } from './logger';
import { createSessionEvents, type SessionEvents } from './sessionEvents';
import type { AppSupabaseClient } from './supabase';

export interface Dependencies {
  supabase: AppSupabaseClient;
  services: Services;
  links: LinkSource;
  sessionEvents: SessionEvents;
}

/**
 * Operations whose UNAUTHENTICATED answer is a normal outcome (e.g. a wrong
 * password), not a sign that the current session expired.
 */
const SIGNED_OUT_OPERATIONS = new Set([
  'auth.signIn',
  'auth.signUp',
  'auth.signOut',
  'auth.requestPasswordReset',
  'auth.handleAuthRedirect',
]);

export function createDependencies(
  supabase: AppSupabaseClient,
  links: LinkSource = expoLinkSource,
): Dependencies {
  const sessionEvents = createSessionEvents();
  const services = createServices(supabase, {
    logger,
    onError: (error, operation) => {
      if (error.code === ErrorCode.Unauthenticated && !SIGNED_OUT_OPERATIONS.has(operation))
        sessionEvents.emitExpired();
    },
  });
  return { supabase, services, links, sessionEvents };
}

export function DependenciesProvider({ value, children }: { value: Dependencies; children: ReactNode }) {
  return <DependenciesContext.Provider value={value}>{children}</DependenciesContext.Provider>;
}

const DependenciesContext = createContext<Dependencies | null>(null);

export function useDependencies(): Dependencies {
  const value = useContext(DependenciesContext);
  if (!value) throw new Error('DependenciesProvider is missing');
  return value;
}

/** Business operations (services/): the only way screens talk to the backend. */
export const useServices = (): Services => useDependencies().services;

/** The raw client, for auth state only. Data access goes through useServices(). */
export const useSupabase = (): AppSupabaseClient => useDependencies().supabase;
