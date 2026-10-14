# Stage B: Marketplace Catalog

**Status:** implemented and tested; the Stage B row of the status matrix in
[`README.md`](README.md) is marked done. There is no cart, checkout or payment yet (Stages C–E).

- **Migration 32:** `supabase/migrations/20261011003200_marketplace_catalog.sql`
- **Service:** `services/marketplace/index.ts` (`services.marketplace`)
- **App:**
  - `apps/mobile/src/features/marketplace/`: storefront, listing page, seller page, your shop, listing editor, saved
  - The Market tab is now the community's storefront.
- **Tests:**
  - `supabase/tests/database/032_marketplace_catalog.test.sql` (63)
  - `tests/services/marketplace.test.ts` (6, real Supabase)
  - `apps/mobile/src/features/marketplace/marketplace.test.tsx` (17)
  - Updated: permission counts in `001`, `002`, `011` and `tests/integration/communities-and-memberships.test.mjs`

## Scope: per community (decision D1)

Everything belongs to one community:
- seller profiles ("shops");
- listings and their pictures;
- stock;
- favorites.

Only active members with the right permission see, save or sell there.
Another community's listings cannot be searched, opened, saved or seen as
pictures; the database refuses and tests check it.

## Permissions (new)

| Key | Granted to (templates and every existing community) | Allows |
|---|---|---|
| `marketplace.view` | Member, Moderator, Admin, Owner | Browse, search, open listings and pictures |
| `marketplace.buy` | Member, Moderator, Admin, Owner | Reserved for the cart and checkout (Stage C) |
| `marketplace.sell` | Member, Moderator, Admin, Owner | Open a shop, list, upload pictures, set stock |
| `marketplace.manage` | Admin, Owner | Remove listings (with a reason) and suspend or reinstate sellers. Cannot edit them, and cannot see drafts. |

Rules come from permissions only, never role names. A community can restrict
selling by removing `marketplace.sell` from a role.

## What it does

**Storefront (Market tab):**
- search, combining stemmed full text with partial words in the title (`%` and `_` are taken literally);
- categories;
- sort: newest, price either way, best match when searching;
- filters: products or services, condition, a price range (refused before sending if not a number), in stock only;
- a two-column grid (picture, title, price, stock, seller) with a heart to save.

**Listing page:**
- picture gallery (1/N);
- price, which is fixed, per hour or "Price on request";
- stock in words: "In stock", "Only 2 left", "Out of stock";
- condition, delivery options and area;
- description;
- the seller, linking to the seller page.

There is no buy button: the page says checkout arrives in a later update.

**Your shop:**
- open a shop (name, description), edit it, pause or reopen it;
- every listing with its status and stock.

**Listing editor:**
- product or service;
- photos from the library or camera (up to 10, re-encoded on the device, which removes GPS data);
- title and category;
- price: products have a fixed price; services are fixed, per hour or quote;
- condition, stock, pickup and/or seller delivery, area, description;
- publish, or save as a draft.

**Seller controls on a listing:** edit, pause, resume, remove (with
confirmation). A removed listing stays removed.

**Moderation:** a manager removes a listing with a reason, and the removal is
audited. Suspending a seller hides all their listings. A suspended seller
cannot lift the suspension or list anything.

## Rules enforced by the database

| Rule | Where |
|---|---|
| A seller sells only under their own shop in that community; the shop must be active | `enforce_listing_write` trigger |
| Owner, verification and status of a new shop are set by the server. Nobody verifies themselves; verification is for operators (D8). | `enforce_seller_profile_write` |
| Products need a fixed price, a condition and at least one delivery option. Services have no condition. Quote ⇔ no price. JMD only (D10). Price ≤ JMD 10 billion. | Check constraints |
| Category must match the kind (product or service) | Trigger |
| Listing status moves: draft → active / removed; active ⇄ paused; any → removed (final) | Trigger |
| Managers can only remove (with a reason) or suspend/reinstate; they never edit | Triggers. Audited: `listing.removed`, `seller.suspended`, `seller.reinstated` |
| **Stock** changes only through `set_listing_stock()`: seller only, products only, 0–1,000,000, never below reserved. Every change is recorded in append-only `inventory_movements` and audited (`inventory.adjusted`). | SECURITY DEFINER function, no write grants |
| Pictures: private `listing-images` bucket, own folder (`{community}/{user}/{uuid}.jpg`), no overwrite. A listing picture must be the seller's own uploaded file in that community. Readable by whoever can see the listing (and the uploader). Unused files are listed by `list_listing_image_files_to_purge()`. | Storage policies, trigger |
| Visibility: members see active listings of active shops; sellers see all their own; managers see all but drafts | `can_view_listing_row()` |
| Favorites: your own only, on listings you can see | RLS and trigger |
| Rate limit: 30 new listings per user per hour | `listing.create` rule |

**Reserved stock.** `inventory.reserved` stays 0 until checkout reserves
stock (Stage D). Shown availability is always `on_hand − reserved`.

## Deploying

Apply migration 32 to the hosted project with `supabase db push`. It creates
the private `listing-images` bucket and grants the new permissions to every
existing community's system roles.

## Known limitations (planned later)

- **No buying in the app yet:** cart, checkout, payments, orders and bookings are Stages C–J.
- **Search paging:** offset-based, up to about 1,000 results per query (refine the search for more).
- **Pictures:** cannot be reordered (remove and add again). The purge job for unused pictures is not scheduled yet.
- **No platform-wide or cross-community listing** (decision D1).
