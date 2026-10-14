// Marketplace Stage B through the whole app (REAL service layer) against a
// fake Supabase applying the database rules (fakeMarket.ts mirrors
// migration 32): storefront, search, filters, sorting, listing pages,
// favorites, the seller workflow, moderation, permissions and isolation
// between communities (decision D1: per community).
import { fireEvent, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import {
  makeSession,
  makePhoto,
  OTHER_USER_ID,
  sampleCommunities,
  TEST_USER_ID,
  type FakeOptions,
} from '@/testing/fakeSupabase';
import { categoryId, makeListing, makeSellerProfile } from '@/testing/fakeMarket';
import { renderApp } from '@/testing/render';
import { availabilityLine, formatMoney, parsePrice, priceLabel } from './marketRules';

afterEach(() => jest.restoreAllMocks());

const [maple, choir] = sampleCommunities as [
  (typeof sampleCommunities)[number],
  (typeof sampleCommunities)[number],
];
const M = maple.community_id; // Owner (marketplace.manage)
const C = choir.community_id; // Member

const grace = makeSellerProfile(C, OTHER_USER_ID, 1, { display_name: 'Grace Goods' });
const mapleShop = makeSellerProfile(M, OTHER_USER_ID, 2, { display_name: 'Maple Shop' });
const laptop = makeListing(grace, 1, {
  title: 'Used laptop',
  description: 'Fast laptop, 8GB RAM',
  price_minor: 4_500_000,
  on_hand: 3,
  images: [`${C}/${OTHER_USER_ID}/11111111-1111-4111-8111-111111111111.jpg`],
});
const sofa = makeListing(grace, 2, {
  title: 'Blue sofa',
  category_id: categoryId('furniture'),
  condition: 'fair',
  price_minor: 2_000_000,
  on_hand: 0,
});
const cleaning = makeListing(grace, 3, {
  kind: 'service',
  title: 'Home cleaning',
  category_id: categoryId('cleaning'),
  pricing: 'hourly',
  price_minor: 250_000,
});
const draft = makeListing(grace, 4, { title: 'Secret draft', status: 'draft' });
const mapleItem = makeListing(mapleShop, 5, { title: 'Maple lawnmower' });

const market = () => ({
  sellers: [{ ...grace }, { ...mapleShop }],
  listings: [{ ...laptop }, { ...sofa }, { ...cleaning }, { ...draft }, { ...mapleItem }],
});

async function openMarket(options: FakeOptions = {}, communities: unknown[] = [choir]) {
  const user = userEvent.setup();
  const app = await renderApp({ session: makeSession(), communities, market: market(), ...options });
  await user.press(await screen.findByRole('button', { name: /^Market/ }));
  await screen.findByTestId('market-screen');
  await screen.findByTestId('market-results');
  return { user, ...app };
}

const titles = () =>
  within(screen.getByTestId('market-results'))
    .queryAllByRole('button')
    .map((b) => b.props.accessibilityLabel as string)
    .filter((l) => /, /.test(l) && !/^(Save|Remove) /.test(l))
    .map((l) => l.split(', ')[0]);

describe('storefront', () => {
  test("members see this community's live listings with price, stock and seller", async () => {
    await openMarket();
    expect(titles()).toEqual(['Home cleaning', 'Blue sofa', 'Used laptop']);
    const tile = screen.getByTestId(`listing-${laptop.id}`);
    expect(tile).toHaveTextContent(/J\$45,000/);
    expect(tile).toHaveTextContent(/Only 3 left/);
    expect(tile).toHaveTextContent(/Grace Goods/);
    expect(screen.getByTestId(`listing-${sofa.id}`)).toHaveTextContent(/Out of stock/);
    expect(screen.getByTestId(`listing-${cleaning.id}`)).toHaveTextContent(/J\$2,500 \/ hour/);
    // Drafts and other communities' listings never appear.
    expect(screen.queryByText('Secret draft')).not.toBeOnTheScreen();
    expect(screen.queryByText('Maple lawnmower')).not.toBeOnTheScreen();
  });

  test('search, category, sort and filters run on the server', async () => {
    const { user, rpc } = await openMarket();
    await user.type(screen.getByLabelText('Search the marketplace'), 'laptop');
    await waitFor(() => expect(titles()).toEqual(['Used laptop']));
    expect(rpc).toHaveBeenLastCalledWith(
      'search_listings',
      expect.objectContaining({ p_query: 'laptop', p_community_id: C }),
    );
    await user.press(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(titles()).toHaveLength(3));

    await user.press(
      within(screen.getByTestId('market-categories')).getByRole('radio', { name: 'Furniture' }),
    );
    await waitFor(() => expect(titles()).toEqual(['Blue sofa']));
    await user.press(within(screen.getByTestId('market-categories')).getByRole('radio', { name: 'All' }));

    await user.press(
      within(screen.getByTestId('market-sort')).getByRole('radio', { name: 'Price: low to high' }),
    );
    await waitFor(() => expect(titles()).toEqual(['Home cleaning', 'Blue sofa', 'Used laptop']));
    await user.press(
      within(screen.getByTestId('market-sort')).getByRole('radio', { name: 'Price: high to low' }),
    );
    await waitFor(() => expect(titles()).toEqual(['Used laptop', 'Blue sofa', 'Home cleaning']));

    await user.press(screen.getByRole('button', { name: 'Show filters' }));
    const filters = screen.getByTestId('market-filters');
    fireEvent(within(filters).getByLabelText('In stock only'), 'valueChange', true);
    await waitFor(() => expect(titles()).toEqual(['Used laptop', 'Home cleaning']));
    await user.press(within(filters).getByRole('radio', { name: 'Services' }));
    await waitFor(() => expect(titles()).toEqual(['Home cleaning']));
  });

  test('a price filter that is not a number is explained and not sent', async () => {
    const { user } = await openMarket();
    await user.press(screen.getByRole('button', { name: 'Show filters' }));
    await user.type(screen.getByLabelText('Maximum price'), 'cheap');
    expect(await screen.findByText(/Enter an amount like 4500/)).toBeOnTheScreen();
    await user.clear(screen.getByLabelText('Maximum price'));
    await user.type(screen.getByLabelText('Maximum price'), '25,000');
    await waitFor(() => expect(titles()).toEqual(['Home cleaning', 'Blue sofa']));
  });

  test('saving from a tile, then the Saved screen; unsaving removes it', async () => {
    const { user, market: state } = await openMarket();
    await user.press(screen.getByRole('button', { name: 'Save Used laptop' }));
    await waitFor(() => expect(state.favorites.map((f) => f.listing_id)).toEqual([laptop.id]));
    expect(state.favorites[0]!.user_id).toBe(TEST_USER_ID);
    await user.press(screen.getByRole('button', { name: 'Saved listings' }));
    const saved = await screen.findByTestId('saved-listings');
    expect(within(saved).getByTestId(`listing-${laptop.id}`)).toBeOnTheScreen();
    await user.press(within(saved).getByRole('button', { name: 'Remove Used laptop from saved' }));
    await waitFor(() => expect(state.favorites).toEqual([]));
    expect(screen.queryByTestId(`listing-${laptop.id}`)).not.toBeOnTheScreen();
  });
});

describe('listing page', () => {
  test('pictures, price, stock, details and the seller; no buying yet', async () => {
    const { user } = await openMarket();
    await user.press(screen.getByTestId(`listing-${laptop.id}`));
    await screen.findByTestId('listing-screen');
    expect(screen.getAllByTestId('listing-picture')).toHaveLength(1);
    expect(screen.getByTestId('listing-price')).toHaveTextContent('J$45,000');
    expect(screen.getByTestId('listing-availability')).toHaveTextContent('Only 3 left');
    expect(screen.getByText('Good')).toBeOnTheScreen();
    expect(screen.getByText('Pickup')).toBeOnTheScreen();
    expect(screen.getByTestId('listing-checkout-note')).toBeOnTheScreen();
    expect(screen.queryByTestId('listing-owner-controls')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('listing-moderation')).not.toBeOnTheScreen();
    await user.press(screen.getByTestId('listing-seller'));
    const shop = await screen.findByTestId('seller-listings');
    expect(within(shop).getByTestId(`listing-${sofa.id}`)).toBeOnTheScreen();
    expect(within(shop).queryByText('Secret draft')).not.toBeOnTheScreen();
  });

  test('saving from the listing page', async () => {
    const { user, market: state } = await openMarket();
    await user.press(screen.getByTestId(`listing-${sofa.id}`));
    await user.press(await screen.findByTestId('listing-save'));
    await waitFor(() => expect(state.favorites.map((f) => f.listing_id)).toEqual([sofa.id]));
  });
});

describe('selling', () => {
  test('open a shop, list a product with a photo and stock, publish', async () => {
    const { user, media, market: state } = await openMarket();
    await user.press(screen.getByRole('button', { name: 'Your shop' }));
    await screen.findByTestId('shop-form');
    await user.type(screen.getByLabelText('Shop name'), "Ada's Attic");
    await user.press(screen.getByRole('button', { name: 'Open my shop' }));
    expect(await screen.findByTestId('shop-done')).toHaveTextContent(/Your shop is open/);
    expect(state.sellers.find((s) => s.user_id === TEST_USER_ID)).toMatchObject({
      display_name: "Ada's Attic",
      status: 'active',
      verification_status: 'unverified',
    });

    await user.press(screen.getByRole('button', { name: 'New listing' }));
    await screen.findByTestId('listing-editor-screen');
    media.nextPhotos([makePhoto(1)]);
    await user.press(screen.getByRole('button', { name: 'Add photos' }));
    expect(await screen.findAllByTestId('pending-photo')).toHaveLength(1);
    await user.type(screen.getByLabelText('Title'), 'Rice cooker');
    await user.press(screen.getByRole('radio', { name: 'Electronics' }));
    await user.type(screen.getByLabelText('Price (J$)'), '8,500');
    await user.press(screen.getByRole('radio', { name: 'Like new' }));
    await user.clear(screen.getByLabelText('How many do you have?'));
    await user.type(screen.getByLabelText('How many do you have?'), '2');
    await user.press(screen.getByRole('button', { name: 'Publish' }));

    expect(await screen.findByTestId('listing-screen')).toBeOnTheScreen();
    const mine = state.listings.find((l) => l.title === 'Rice cooker')!;
    expect(mine).toMatchObject({
      seller_user_id: TEST_USER_ID,
      status: 'active',
      price_minor: 850_000,
      condition: 'like_new',
      fulfillment: ['pickup'],
    });
    expect(state.inventory.get(mine.id)).toEqual({ on_hand: 2, reserved: 0 });
    expect(state.images.filter((i) => i.listing_id === mine.id)).toHaveLength(1);
    expect(screen.getByTestId('listing-stock')).toHaveTextContent('Stock: 2');
  });

  test('missing price and category are caught before anything is sent', async () => {
    const seller = makeSellerProfile(C, TEST_USER_ID, 9);
    const { user, queries } = await openMarket({ market: { sellers: [seller], listings: [] } });
    await user.press(screen.getByRole('button', { name: 'Your shop' }));
    await user.press(await screen.findByRole('button', { name: 'New listing' }));
    await user.type(await screen.findByLabelText('Title'), 'Desk');
    await user.press(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Choose a category.')).toBeOnTheScreen();
    expect(screen.getByText('Enter a price.')).toBeOnTheScreen();
    expect(queries.filter((q) => q.table === 'listings' && q.op === 'insert')).toEqual([]);
  });

  test('a quote-priced service, saved as a draft', async () => {
    const seller = makeSellerProfile(C, TEST_USER_ID, 9);
    const { user, market: state } = await openMarket({ market: { sellers: [seller], listings: [] } });
    await user.press(screen.getByRole('button', { name: 'Your shop' }));
    await user.press(await screen.findByRole('button', { name: 'New listing' }));
    await user.press(await screen.findByRole('radio', { name: 'Service' }));
    await user.type(screen.getByLabelText('Title'), 'Phone screen repair');
    await user.press(screen.getByRole('radio', { name: 'Tech help' }));
    await user.press(screen.getByRole('radio', { name: 'Price on request' }));
    await user.press(screen.getByRole('button', { name: 'Save as draft' }));
    await screen.findByTestId('listing-screen');
    expect(state.listings.find((l) => l.title === 'Phone screen repair')).toMatchObject({
      kind: 'service',
      pricing: 'quote',
      price_minor: null,
      status: 'draft',
    });
    expect(screen.getByTestId('listing-status')).toHaveTextContent(/Draft: only you can see it/);
    expect(screen.getByTestId('listing-price')).toHaveTextContent('Price on request');
  });

  test('the seller edits the price and stock, pauses, resumes and removes', async () => {
    const seller = makeSellerProfile(C, TEST_USER_ID, 9);
    const own = makeListing(seller, 7, { title: 'My bike', price_minor: 1_500_000, on_hand: 1 });
    const { user, market: state } = await openMarket({ market: { sellers: [seller], listings: [own] } });
    await user.press(screen.getByTestId(`listing-${own.id}`));
    const controls = await screen.findByTestId('listing-owner-controls');
    await user.press(within(controls).getByRole('button', { name: 'Edit' }));
    const price = await screen.findByLabelText('Price (J$)');
    expect(price.props.value).toBe('15000');
    await user.clear(price);
    await user.type(price, '12000');
    await user.clear(screen.getByLabelText('How many do you have?'));
    await user.type(screen.getByLabelText('How many do you have?'), '4');
    await user.press(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(state.listings.find((l) => l.id === own.id)!.price_minor).toBe(1_200_000));
    expect(state.inventory.get(own.id)!.on_hand).toBe(4);

    await user.press(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(state.listings.find((l) => l.id === own.id)!.status).toBe('paused'));
    await user.press(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(state.listings.find((l) => l.id === own.id)!.status).toBe('active'));
    await user.press(await screen.findByRole('button', { name: 'Remove' }));
    await user.press(screen.getByRole('button', { name: 'Remove listing' }));
    await waitFor(() => expect(state.listings.find((l) => l.id === own.id)!.status).toBe('removed'));
    expect(state.listings.find((l) => l.id === own.id)!.removed_by).toBe(TEST_USER_ID);
  });

  test('a suspended shop is told so and cannot list anything', async () => {
    const seller = makeSellerProfile(C, TEST_USER_ID, 9, { status: 'suspended' });
    const { user, dependencies } = await openMarket({ market: { sellers: [seller], listings: [] } });
    await user.press(screen.getByRole('button', { name: 'Your shop' }));
    expect(await screen.findByTestId('shop-status')).toHaveTextContent(/Suspended by a community admin/);
    expect(screen.queryByRole('button', { name: 'New listing' })).not.toBeOnTheScreen();
    await expect(
      dependencies.services.marketplace.createListing({
        communityId: C,
        kind: 'product',
        categoryId: categoryId('electronics'),
        title: 'Sneaky',
        condition: 'new',
        priceMinor: 100,
        fulfillment: ['pickup'],
        publish: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('moderation and permissions', () => {
  test('a marketplace manager removes a listing with a reason; members cannot', async () => {
    const mapleSofa = makeListing(mapleShop, 8, { title: 'Dodgy watch' });
    const { user, market: state } = await openMarket(
      { market: { sellers: [mapleShop], listings: [mapleSofa] } },
      [maple],
    );
    await user.press(screen.getByTestId(`listing-${mapleSofa.id}`));
    const moderation = await screen.findByTestId('listing-moderation');
    await user.press(within(moderation).getByRole('button', { name: 'Remove this listing' }));
    await user.type(screen.getByLabelText('Reason for removing'), 'Counterfeit');
    await user.press(screen.getByRole('button', { name: 'Remove listing' }));
    await waitFor(() =>
      expect(state.listings.find((l) => l.id === mapleSofa.id)).toMatchObject({
        status: 'removed',
        removal_reason: 'Counterfeit',
      }),
    );
  });

  test('a manager cannot edit someone else’s listing, and a member cannot moderate', async () => {
    const app = await renderApp({ session: makeSession(), communities: [maple, choir], market: market() });
    await screen.findByRole('button', { name: /^St\. Mark Choir/ });
    const m = app.dependencies.services.marketplace;
    await expect(m.updateListing(mapleItem.id, { title: 'Hijacked' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(m.moderateRemove(laptop.id, 'not mine')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(m.setStock(laptop.id, 99)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(app.market.listings.find((l) => l.id === laptop.id)!.status).toBe('active');
  });

  test('without marketplace.sell there is no shop; without marketplace.view no marketplace', async () => {
    await openMarket({ permissions: { [C]: ['community.view', 'marketplace.view', 'marketplace.buy'] } });
    expect(screen.queryByRole('button', { name: 'Your shop' })).not.toBeOnTheScreen();
  });

  test('a member without marketplace.view is told the marketplace is not available', async () => {
    const user = userEvent.setup();
    await renderApp({
      session: makeSession(),
      communities: [choir],
      market: market(),
      permissions: { [C]: ['community.view', 'posts.view'] },
    });
    await user.press(await screen.findByRole('button', { name: /^Market/ }));
    expect(await screen.findByText('Marketplace not available')).toBeOnTheScreen();
  });

  test("another community's listing cannot be opened, saved or searched", async () => {
    const app = await renderApp({ session: makeSession(), communities: [choir], market: market() });
    await screen.findByTestId('feed-screen');
    const m = app.dependencies.services.marketplace;
    await expect(m.listing(mapleItem.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(m.setFavorite(mapleItem.id, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(m.search({ communityId: M })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(app.market.favorites).toEqual([]);
  });
});

describe('rules', () => {
  test('money, prices and stock in words', () => {
    expect(formatMoney(4_500_000)).toBe('J$45,000');
    expect(formatMoney(4_500_050)).toBe('J$45,000.50');
    expect(formatMoney(5)).toBe('J$0.05');
    expect(priceLabel({ pricing: 'quote', priceMinor: null, currency: 'JMD' })).toBe('Price on request');
    expect(priceLabel({ pricing: 'hourly', priceMinor: 250_000, currency: 'JMD' })).toBe('J$2,500 / hour');
    expect(parsePrice('J$45,000.5')).toEqual({ minor: 4_500_050 });
    expect(parsePrice('')).toEqual({ minor: null });
    expect(parsePrice('-5')).toHaveProperty('error');
    expect(parsePrice('1.234')).toHaveProperty('error');
    expect(availabilityLine('product', 0)).toMatchObject({ text: 'Out of stock' });
    expect(availabilityLine('product', 10)).toMatchObject({ text: 'In stock' });
    expect(availabilityLine('service', null)).toBeNull();
  });
});
