// Route names and parameters for every navigator (typed navigation).
import type { NavigatorScreenParams } from '@react-navigation/native';

/** Signed-out flow. */
export type AuthStackParamList = {
  Welcome: undefined;
  SignIn: undefined;
  SignUp: undefined;
  ForgotPassword: undefined;
};

/** Main tabs once signed in. */
export type AppTabParamList = {
  Communities: undefined;
  Notifications: undefined;
  Profile: undefined;
};

/** Sections inside one community. Every route carries the community it belongs to. */
export type CommunitySection = 'feed' | 'announcements' | 'alerts' | 'events' | 'documents' | 'members';

export type CommunityStackParamList = {
  CommunityHome: undefined;
  CommunitySection: { section: CommunitySection };
};

/** Top level: exactly one of the Auth / App branches exists at a time. */
export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList>;
  App: NavigatorScreenParams<AppTabParamList>;
  Community: { communityId: string; name?: string } & Partial<NavigatorScreenParams<CommunityStackParamList>>;
  /** Modal: join a community from an invitation link or code. */
  JoinCommunity: { token?: string } | undefined;
  /** Recovery mode only: choose a new password after a reset link. */
  ResetPassword: undefined;
};

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
