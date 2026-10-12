// The community a set of screens belongs to. Screens inside the community
// navigator read it from here instead of passing ids around.
import { createContext, useContext, type ReactNode } from 'react';

export interface CommunityScope {
  communityId: string;
  name?: string;
}

const CommunityContext = createContext<CommunityScope | null>(null);

export function CommunityProvider({ value, children }: { value: CommunityScope; children: ReactNode }) {
  return <CommunityContext.Provider value={value}>{children}</CommunityContext.Provider>;
}

export function useCommunity(): CommunityScope {
  const value = useContext(CommunityContext);
  if (!value) throw new Error('useCommunity must be used inside the community navigator');
  return value;
}
