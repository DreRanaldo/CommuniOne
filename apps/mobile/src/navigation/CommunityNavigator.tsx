import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { MyCommunity } from '@communione/services';
import { ErrorState, LoadingState } from '@/components';
import { useCurrentCommunity } from '@/features/communities/CurrentCommunityProvider';
import { AdminMemberScreen } from '@/features/admin/screens/AdminMemberScreen';
import { AdminMembersScreen } from '@/features/admin/screens/AdminMembersScreen';
import { AdminScreen } from '@/features/admin/screens/AdminScreen';
import { InvitationsScreen } from '@/features/admin/screens/InvitationsScreen';
import { ModerationScreen } from '@/features/admin/screens/ModerationScreen';
import { ChooseCommunityScreen } from '@/features/communities/screens/ChooseCommunityScreen';
import { CommunityHomeScreen } from '@/features/communities/screens/CommunityHomeScreen';
import { AlertDetailScreen } from '@/features/alerts/AlertDetailScreen';
import { AlertEditorScreen } from '@/features/alerts/AlertEditorScreen';
import { AlertsScreen } from '@/features/alerts/AlertsScreen';
import { QuickAlertScreen } from '@/features/alerts/QuickAlertScreen';
import { DocumentDetailScreen } from '@/features/documents/screens/DocumentDetailScreen';
import { DocumentsScreen } from '@/features/documents/screens/DocumentsScreen';
import { DocumentUploadScreen } from '@/features/documents/screens/DocumentUploadScreen';
import { EventDetailScreen } from '@/features/events/EventDetailScreen';
import { EventEditorScreen } from '@/features/events/EventEditorScreen';
import { EventsScreen } from '@/features/events/EventsScreen';
import { AnnouncementDetailScreen } from '@/features/announcements/AnnouncementDetailScreen';
import { AnnouncementEditorScreen } from '@/features/announcements/AnnouncementEditorScreen';
import { AnnouncementsScreen } from '@/features/announcements/AnnouncementsScreen';
import { PostDetailScreen } from '@/features/comments/PostDetailScreen';
import { FeedScreen } from '@/features/feed/screens/FeedScreen';
import { AddressEditorScreen } from '@/features/marketplace/screens/AddressEditorScreen';
import { CartScreen } from '@/features/marketplace/screens/CartScreen';
import { CheckoutScreen } from '@/features/marketplace/screens/CheckoutScreen';
import { BookingDetailScreen } from '@/features/marketplace/screens/BookingDetailScreen';
import { BookingsScreen } from '@/features/marketplace/screens/BookingsScreen';
import { BookServiceScreen } from '@/features/marketplace/screens/BookServiceScreen';
import { DeliverySettingsScreen } from '@/features/marketplace/screens/DeliverySettingsScreen';
import { EarningsScreen } from '@/features/marketplace/screens/EarningsScreen';
import { DisputeScreen } from '@/features/marketplace/screens/DisputeScreen';
import { DisputesScreen } from '@/features/marketplace/screens/DisputesScreen';
import { ListingDetailScreen } from '@/features/marketplace/screens/ListingDetailScreen';
import { ListingEditorScreen } from '@/features/marketplace/screens/ListingEditorScreen';
import { MarketHomeScreen } from '@/features/marketplace/screens/MarketHomeScreen';
import { OrderDetailScreen } from '@/features/marketplace/screens/OrderDetailScreen';
import { OrdersScreen } from '@/features/marketplace/screens/OrdersScreen';
import { PaymentScreen } from '@/features/marketplace/screens/PaymentScreen';
import { RefundRequestScreen } from '@/features/marketplace/screens/RefundRequestScreen';
import { RefundSettingsScreen } from '@/features/marketplace/screens/RefundSettingsScreen';
import { ServiceHoursScreen } from '@/features/marketplace/screens/ServiceHoursScreen';
import { SavedListingsScreen } from '@/features/marketplace/screens/SavedListingsScreen';
import { SellerScreen } from '@/features/marketplace/screens/SellerScreen';
import { ShopScreen } from '@/features/marketplace/screens/ShopScreen';
import { PostEditorScreen } from '@/features/feed/screens/PostEditorScreen';
import { MemberProfileScreen } from '@/features/members/screens/MemberProfileScreen';
import { MembersScreen } from '@/features/members/screens/MembersScreen';
import { CommunitySettingsScreen } from '@/features/settings/screens/CommunitySettingsScreen';
import { EditCommunityScreen } from '@/features/settings/screens/EditCommunityScreen';
import type { CommunityStackParamList } from '@/types/navigation';
import { errorMessage } from '@/utils/errors';
import { useStackOptions } from './options';

const Stack = createNativeStackNavigator<CommunityStackParamList>();

type StackRoot = 'Feed' | 'CommunityHome' | 'Market';

/**
 * A tab that shows the current community (from CurrentCommunityProvider,
 * never from a route parameter), starting at `root`. With no community
 * selected it shows the list to choose one. Switching community remounts the
 * stack, so no screen of the previous community stays open.
 */
function CommunityTab({ root }: { root: StackRoot }) {
  const { status, error, current, retry } = useCurrentCommunity();
  if (status === 'loading' || status === 'idle') return <LoadingState label="Loading your communities…" />;
  if (status === 'error') {
    return (
      <ErrorState
        title="Your communities could not be loaded"
        message={errorMessage(error)}
        onRetry={retry}
      />
    );
  }
  if (!current) return <ChooseCommunityScreen />;
  return <CommunityStack key={current.community_id} community={current} root={root} />;
}

/** Home tab: the current community's feed. */
export const HomeNavigator = () => <CommunityTab root="Feed" />;
/** Communities tab: the current community's hub (sections, announcements, events). */
export const CommunityHubNavigator = () => <CommunityTab root="CommunityHome" />;
/** Market tab: the current community's marketplace (per community, decision D1). */
export const MarketNavigator = () => <CommunityTab root="Market" />;

function CommunityStack({ community, root }: { community: MyCommunity; root: StackRoot }) {
  const screenOptions = useStackOptions();
  return (
    <Stack.Navigator screenOptions={screenOptions} initialRouteName={root}>
      <Stack.Screen
        name="CommunityHome"
        component={CommunityHomeScreen}
        options={{ title: community.name, headerShown: false }}
      />
      <Stack.Screen name="Feed" component={FeedScreen} options={{ headerShown: false, title: 'Home' }} />
      <Stack.Screen name="PostDetail" component={PostDetailScreen} options={{ title: 'Post' }} />
      <Stack.Screen name="Documents" component={DocumentsScreen} options={{ title: 'Documents' }} />
      <Stack.Screen name="DocumentDetail" component={DocumentDetailScreen} options={{ title: 'Document' }} />
      <Stack.Screen
        name="DocumentUpload"
        component={DocumentUploadScreen}
        options={{ title: 'Upload a document', presentation: 'modal' }}
      />
      <Stack.Screen name="Events" component={EventsScreen} options={{ title: 'Events' }} />
      <Stack.Screen name="EventDetail" component={EventDetailScreen} options={{ title: 'Event' }} />
      <Stack.Screen
        name="EventEditor"
        component={EventEditorScreen}
        options={{ title: 'New event', presentation: 'modal' }}
      />
      <Stack.Screen name="Alerts" component={AlertsScreen} options={{ title: 'Alerts' }} />
      <Stack.Screen
        name="QuickAlert"
        component={QuickAlertScreen}
        options={{ title: 'Quick alert', presentation: 'modal' }}
      />
      <Stack.Screen name="AlertDetail" component={AlertDetailScreen} options={{ title: 'Alert' }} />
      <Stack.Screen
        name="AlertEditor"
        component={AlertEditorScreen}
        options={{ title: 'New alert', presentation: 'modal' }}
      />
      <Stack.Screen
        name="Announcements"
        component={AnnouncementsScreen}
        options={{ title: 'Announcements' }}
      />
      <Stack.Screen
        name="AnnouncementDetail"
        component={AnnouncementDetailScreen}
        options={{ title: 'Announcement' }}
      />
      <Stack.Screen
        name="AnnouncementEditor"
        component={AnnouncementEditorScreen}
        options={{ title: 'New announcement', presentation: 'modal' }}
      />
      <Stack.Screen
        name="PostEditor"
        component={PostEditorScreen}
        options={{ title: 'New post', presentation: 'modal' }}
      />
      <Stack.Screen name="Members" component={MembersScreen} options={{ title: 'Members' }} />
      <Stack.Screen
        name="CommunitySettings"
        component={CommunitySettingsScreen}
        options={{ title: 'Community settings' }}
      />
      <Stack.Screen
        name="EditCommunity"
        component={EditCommunityScreen}
        options={{ title: 'Edit community', presentation: 'modal' }}
      />
      <Stack.Screen name="MemberProfile" component={MemberProfileScreen} options={{ title: 'Member' }} />
      <Stack.Screen
        name="Market"
        component={MarketHomeScreen}
        options={{ headerShown: false, title: 'Market' }}
      />
      <Stack.Screen name="Listing" component={ListingDetailScreen} options={{ title: '' }} />
      <Stack.Screen name="Seller" component={SellerScreen} options={{ title: 'Shop' }} />
      <Stack.Screen name="Shop" component={ShopScreen} options={{ title: 'Your shop' }} />
      <Stack.Screen
        name="ListingEditor"
        component={ListingEditorScreen}
        options={({ route }) => ({
          title: route.params?.listingId ? 'Edit listing' : 'New listing',
          presentation: 'modal',
        })}
      />
      <Stack.Screen name="SavedListings" component={SavedListingsScreen} options={{ title: 'Saved' }} />
      <Stack.Screen name="Cart" component={CartScreen} options={{ title: 'Cart' }} />
      <Stack.Screen name="Checkout" component={CheckoutScreen} options={{ title: 'Checkout' }} />
      <Stack.Screen name="AddressEditor" component={AddressEditorScreen} options={{ title: 'New address' }} />
      <Stack.Screen name="Payment" component={PaymentScreen} options={{ title: 'Payment' }} />
      <Stack.Screen name="Orders" component={OrdersScreen} options={{ title: 'Orders' }} />
      <Stack.Screen name="OrderDetail" component={OrderDetailScreen} options={{ title: 'Order' }} />
      <Stack.Screen
        name="DeliverySettings"
        component={DeliverySettingsScreen}
        options={{ title: 'Delivery' }}
      />
      <Stack.Screen
        name="RefundRequest"
        component={RefundRequestScreen}
        options={{ title: 'Request a refund' }}
      />
      <Stack.Screen name="Dispute" component={DisputeScreen} options={{ title: 'Dispute' }} />
      <Stack.Screen name="Disputes" component={DisputesScreen} options={{ title: 'Marketplace disputes' }} />
      <Stack.Screen
        name="RefundSettings"
        component={RefundSettingsScreen}
        options={{ title: 'Refund settings' }}
      />
      <Stack.Screen name="BookService" component={BookServiceScreen} options={{ title: 'Book' }} />
      <Stack.Screen name="Bookings" component={BookingsScreen} options={{ title: 'Bookings' }} />
      <Stack.Screen name="BookingDetail" component={BookingDetailScreen} options={{ title: 'Booking' }} />
      <Stack.Screen name="ServiceHours" component={ServiceHoursScreen} options={{ title: 'Booking hours' }} />
      <Stack.Screen name="Earnings" component={EarningsScreen} options={{ title: 'Earnings' }} />
      <Stack.Screen name="Admin" component={AdminScreen} options={{ title: 'Admin tools' }} />
      <Stack.Screen
        name="AdminMembers"
        component={AdminMembersScreen}
        options={{ title: 'Manage members' }}
      />
      <Stack.Screen name="AdminMember" component={AdminMemberScreen} options={{ title: 'Member' }} />
      <Stack.Screen name="Invitations" component={InvitationsScreen} options={{ title: 'Invite members' }} />
      <Stack.Screen name="Moderation" component={ModerationScreen} options={{ title: 'Moderation' }} />
    </Stack.Navigator>
  );
}
