// The app's dependencies (Supabase client + service layer), provided through
// context so screens never import singletons and tests can pass fakes.
import { createContext, useContext, type ReactNode } from 'react';
import { createServices, type Services } from '@communione/services';
import { logger } from './logger';
import type { AppSupabaseClient } from './supabase';

export interface Dependencies {
  supabase: AppSupabaseClient;
  services: Services;
}

const DependenciesContext = createContext<Dependencies | null>(null);

export function createDependencies(supabase: AppSupabaseClient): Dependencies {
  return { supabase, services: createServices(supabase, { logger }) };
}

export function DependenciesProvider({ value, children }: { value: Dependencies; children: ReactNode }) {
  return <DependenciesContext.Provider value={value}>{children}</DependenciesContext.Provider>;
}

function useDependencies(): Dependencies {
  const value = useContext(DependenciesContext);
  if (!value) throw new Error('DependenciesProvider is missing');
  return value;
}

/** Business operations (services/): the only way screens talk to the backend. */
export const useServices = (): Services => useDependencies().services;

/** The raw client, for auth state only. Data access goes through useServices(). */
export const useSupabase = (): AppSupabaseClient => useDependencies().supabase;
