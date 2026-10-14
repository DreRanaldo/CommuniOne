// The app's dependencies (Supabase client, service layer, deep links, session
// events), provided through context so screens never import singletons and
// tests can pass fakes.
import { createContext, useContext, type ReactNode } from 'react';
import { createServices, ErrorCode, type FileUploader, type Services } from '@communione/services';
import { expoLinkSource, type LinkSource } from './links';
import { expoLocationSource, type LocationSource } from './location';
import { logger } from './logger';
import { expoMediaPicker, type MediaPicker } from './media';
import { expoPaymentBrowser, type PaymentBrowser } from './paymentBrowser';
import { createSessionEvents, type SessionEvents } from './sessionEvents';
import type { AppSupabaseClient } from './supabase';

export interface Dependencies {
  supabase: AppSupabaseClient;
  services: Services;
  links: LinkSource;
  sessionEvents: SessionEvents;
  media: MediaPicker;
  /** The device position, read only when the user asks to share it. */
  location: LocationSource;
  /** The payment provider's hosted page (Stage E). */
  paymentBrowser: PaymentBrowser;
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
  // A wrong current password while changing it is not an expired session.
  'auth.changePassword',
]);

export function createDependencies(
  supabase: AppSupabaseClient,
  links: LinkSource = expoLinkSource,
  media: MediaPicker = expoMediaPicker,
  /** Document upload transport (with progress); default: supabase-js. */
  uploadFile?: FileUploader,
  location: LocationSource = expoLocationSource,
  paymentBrowser: PaymentBrowser = expoPaymentBrowser,
): Dependencies {
  const sessionEvents = createSessionEvents();
  const services = createServices(supabase, {
    logger,
    onError: (error, operation) => {
      if (error.code === ErrorCode.Unauthenticated && !SIGNED_OUT_OPERATIONS.has(operation))
        sessionEvents.emitExpired();
    },
    uploadFile,
  });
  return { supabase, services, links, sessionEvents, media, location, paymentBrowser };
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
