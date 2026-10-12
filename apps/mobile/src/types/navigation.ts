// Route names and parameters for every navigator (typed navigation).
import type { NavigatorScreenParams } from '@react-navigation/native';

/** Signed-out flow. */
export type AuthStackParamList = {
  Welcome: undefined;
  SignIn: undefined;
  SignUp: undefined;
  ForgotPassword: undefined;
};

/** The signed-in user's own profile and account. */
export type ProfileStackParamList = {
  ProfileHome: undefined;
  EditProfile: undefined;
  Account: { passwordChanged?: boolean } | undefined;
  ChangePassword: undefined;
  DeleteAccount: undefined;
};

/** Main tabs once signed in. Home is the current community (see CurrentCommunityProvider). */
export type AppTabParamList = {
  Home: NavigatorScreenParams<CommunityStackParamList> | undefined;
  Notifications: undefined;
  Profile: NavigatorScreenParams<ProfileStackParamList> | undefined;
};

/** Sections inside the current community. The community comes from context, never from params. */
export type CommunitySection = 'feed' | 'announcements' | 'alerts' | 'events' | 'documents' | 'members';

export type CommunityStackParamList = {
  CommunityHome: undefined;
  CommunitySection: { section: CommunitySection };
  /** The current community's feed. */
  Feed: undefined;
  /** Write a post, or edit one (`postId`, loaded from the server). */
  PostEditor: { postId?: string } | undefined;
};

/** Top level: exactly one of the Auth / App branches exists at a time. */
export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList>;
  App: NavigatorScreenParams<AppTabParamList>;
  /** Modal: the community switcher. `communityId` (from a link) asks to switch; it is validated first. */
  Communities: { communityId?: string } | undefined;
  /**
   * Modal: join a community with an invitation. `token` comes from a link
   * (communione://join?token=…) or, later, a scanned QR code carrying that
   * link; it is removed from the route as soon as it is read.
   */
  JoinCommunity: { token?: string } | undefined;
  /** Modal: create a community (the caller becomes its Owner). */
  CreateCommunity: undefined;
  /** Recovery mode only: choose a new password after a reset link. */
  ResetPassword: undefined;
};

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
