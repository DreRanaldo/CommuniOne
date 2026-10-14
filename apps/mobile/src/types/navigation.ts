// Route names and parameters for every navigator (typed navigation).
import type { NavigatorScreenParams } from '@react-navigation/native';
import type { FeedPost } from '@communione/services';

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

/**
 * Main tabs once signed in (design pass). Home and Communities are the
 * current community (see CurrentCommunityProvider), each its own stack:
 *   Home        the community feed, with stories
 *   Communities the community hub (sections, alerts, announcements, events, documents)
 *   Discover    finding and joining communities
 *   Marketplace placeholder (a later module)
 *   Profile     the user's own profile and account
 * Alerts open from the hub, the feed's pinned alerts and notifications. A
 * floating "+" above the tab bar opens the Create sheet.
 */
export type AppTabParamList = {
  Home: NavigatorScreenParams<CommunityStackParamList> | undefined;
  CommunitiesTab: NavigatorScreenParams<CommunityStackParamList> | undefined;
  Discover: undefined;
  Marketplace: NavigatorScreenParams<CommunityStackParamList> | undefined;
  Profile: NavigatorScreenParams<ProfileStackParamList> | undefined;
};

/** Sections inside the current community. The community comes from context, never from params. */
export type CommunitySection = 'feed' | 'announcements' | 'alerts' | 'events' | 'documents' | 'members';

export type CommunityStackParamList = {
  CommunityHome: undefined;
  /** The current community's settings (RN-15): notifications, membership, management. */
  CommunitySettings: undefined;
  /** Edit the community's profile (RN-15; community.update). */
  EditCommunity: undefined;
  /** The current community's marketplace (Market tab root; Stage B). */
  Market: undefined;
  /** One listing, read from the server. `warning`: shown once (e.g. a picture failed to upload). */
  Listing: { listingId: string; warning?: string };
  /** A seller's shop in this community. */
  Seller: { sellerProfileId: string };
  /** The user's own shop: profile and listings (marketplace.sell). */
  Shop: undefined;
  /** New listing, or edit one of yours. */
  ListingEditor: { listingId?: string } | undefined;
  /** Listings the user saved. */
  SavedListings: undefined;
  /** The cart for the current community (Stage C); prices are the server's. */
  Cart: undefined;
  /** Checkout (Stage D): pickup/delivery per seller, address, contact, server totals. */
  Checkout: undefined;
  /** Add a delivery address to the user's private address book. */
  AddressEditor: undefined;
  /** Paying for a checkout (Stage E); the status shown is the server's. */
  Payment: { checkoutId: string; bookingId?: undefined } | { bookingId: string; checkoutId?: undefined };
  /** The user's purchases, or (sellers) sales, in the current community. */
  Orders: { side?: 'purchases' | 'sales' } | undefined;
  /** One order, read from the server (buyer, or seller once paid). */
  OrderDetail: { orderId: string };
  /** A seller's delivery fee, parishes and estimate. */
  DeliverySettings: { sellerProfileId: string };
  /** Ask the seller for a refund on one order (Stage I). */
  RefundRequest: { orderId: string };
  /** A dispute (`disputeId`), or open one for an order (`orderId`). */
  Dispute: { disputeId?: string; orderId?: string; bookingId?: string };
  /** marketplace.manage: the community's disputes. */
  Disputes: undefined;
  /** marketplace.manage: refund requests on/off, window, the community's own policy text. */
  RefundSettings: undefined;
  /** Request a booking for a service (Stage J). */
  BookService: { listingId: string };
  /** Service bookings: made by me, or (sellers) received. */
  Bookings: { as?: 'buyer' | 'seller' } | undefined;
  /** One booking, read from the server. */
  BookingDetail: { bookingId: string };
  /** A seller's weekly booking hours. */
  ServiceHours: { sellerProfileId: string };
  /** Admin tools for the current community (RN-16), each shown from permissions. */
  Admin: undefined;
  /** Member management (RN-16): active, requests, suspended. */
  AdminMembers: { status?: 'active' | 'pending' | 'suspended' } | undefined;
  /** One membership, read from the server; must belong to the current community. */
  AdminMember: { membershipId: string };
  /** Invitation codes and links (members.invite). */
  Invitations: undefined;
  /** Hidden and deleted posts (posts.moderate). */
  Moderation: undefined;
  /** The current community's member directory (RN-14). */
  Members: undefined;
  /** One member's community profile (RN-14), read from the server. */
  MemberProfile: { userId: string };
  /** The current community's feed. */
  Feed: undefined;
  /**
   * A post with its comments. `post` is the feed's copy, shown at once; the
   * post is re-read from the server (visibility, current text) on opening.
   */
  PostDetail: { postId: string; post?: FeedPost };
  /** The current community's announcements (current, past, drafts). */
  Announcements: undefined;
  /** One announcement, read from the server. */
  AnnouncementDetail: { announcementId: string };
  /** New announcement, or edit one (`announcementId`, loaded from the server). */
  AnnouncementEditor: { announcementId?: string } | undefined;
  /** The current community's events (upcoming, past, drafts). */
  Events: undefined;
  /** One event with its attendance, read from the server. */
  EventDetail: { eventId: string };
  /** New event, or edit one (`eventId`, loaded from the server). */
  EventEditor: { eventId?: string } | undefined;
  /** One document (metadata and a short-lived download link), read from the server. */
  /** The current community's documents: the top level, or one folder. */
  Documents: { folderId?: string; folderName?: string } | undefined;
  /** One document, read from the server. */
  DocumentDetail: { documentId: string };
  /** Upload a document (into a folder). The folder is checked by the server. */
  DocumentUpload: { folderId?: string; folderName?: string } | undefined;
  /** The current community's alerts (active, history, drafts). */
  Alerts: undefined;
  /** One alert, read from the server. `sent`: just sent from Quick alert (shows a confirmation). */
  AlertDetail: { alertId: string; sent?: boolean };
  /** Quick alert (members can send; migration 31): preset, location, photo, send at once. */
  QuickAlert: undefined;
  /** New alert, or edit one (`alertId`, loaded from the server). */
  AlertEditor: { alertId?: string } | undefined;
  /** Write a post, or edit one (`postId`, loaded from the server). */
  PostEditor: { postId?: string; addPhotos?: boolean } | undefined;
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
  /** The notification center (communione://notifications). */
  Notifications: undefined;
  /** One notification (communione://notifications/<id>), read from the server. */
  NotificationDetail: { notificationId: string };
  /** Modal: create a community (the caller becomes its Owner). */
  CreateCommunity: undefined;
  /** Modal: the centre "+" of the tab bar (what the user may create). */
  Create: undefined;
  /** Modal: add a story to the current community. */
  StoryComposer: undefined;
  /** Full screen: the current community's stories, starting with one author. */
  StoryViewer: { communityId: string; authorId: string };
  /** Recovery mode only: choose a new password after a reset link. */
  ResetPassword: undefined;
};

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
