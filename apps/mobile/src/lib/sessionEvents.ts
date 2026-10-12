// "The backend says this session is no longer valid": raised from any service
// call, handled once by the AuthProvider (local sign-out + notice).
export type SessionListener = () => void;

export interface SessionEvents {
  emitExpired(): void;
  onExpired(listener: SessionListener): () => void;
}

export function createSessionEvents(): SessionEvents {
  const listeners = new Set<SessionListener>();
  return {
    emitExpired: () => listeners.forEach((listener) => listener()),
    onExpired(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
