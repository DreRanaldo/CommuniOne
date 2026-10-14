// Display rules for the marketplace (Stage B). Prices are integer minor units
// (JMD cents) from the server; the app only formats and parses them. Who may
// sell, edit or moderate is decided by the database; these are hints.
import { ErrorCode, isServiceError } from '@communione/services';
import { errorMessage } from '@/utils/errors';

type Can = (key: string) => boolean;

export const canSell = (can: Can) => can('marketplace.sell');
export const canModerate = (can: Can) => can('marketplace.manage');

const CURRENCY_SYMBOL: Record<string, string> = { JMD: 'J$', USD: 'US$' };

/** 4500000 → "J$45,000"; 4500050 → "J$45,000.50". Deterministic (no locale surprises). */
export function formatMoney(minor: number, currency = 'JMD'): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${CURRENCY_SYMBOL[currency] ?? `${currency} `}${grouped}${cents ? `.${String(cents).padStart(2, '0')}` : ''}`;
}

/** The price line of a listing: fixed, per hour, or on request. */
export function priceLabel(l: { pricing: string; priceMinor: number | null; currency: string }): string {
  if (l.pricing === 'quote' || l.priceMinor === null) return 'Price on request';
  return l.pricing === 'hourly'
    ? `${formatMoney(l.priceMinor, l.currency)} / hour`
    : formatMoney(l.priceMinor, l.currency);
}

export const CONDITION_LABELS: Record<string, string> = {
  new: 'New',
  like_new: 'Like new',
  good: 'Good',
  fair: 'Fair',
};

export const FULFILLMENT_LABELS: Record<string, string> = {
  pickup: 'Pickup',
  seller_delivery: 'Seller delivers',
};

export const SORT_LABELS = {
  relevance: 'Best match',
  newest: 'Newest',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
} as const;

/** Availability in words (products); null for services. */
export function availabilityLine(
  kind: string,
  available: number | null,
): { text: string; tone: 'success' | 'danger' | 'muted' } | null {
  if (kind !== 'product' || available === null) return null;
  if (available <= 0) return { text: 'Out of stock', tone: 'danger' };
  if (available <= 3) return { text: `Only ${available} left`, tone: 'danger' };
  return { text: 'In stock', tone: 'success' };
}

/**
 * "45,000", "J$45000.50", "45000" → minor units. Null for empty input; an
 * error message for anything else that is not a positive amount with at most
 * two decimals.
 */
export function parsePrice(text: string): { minor: number | null } | { error: string } {
  const cleaned = text.trim().replace(/^J?\$/i, '').replace(/,/g, '').trim();
  if (cleaned === '') return { minor: null };
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(cleaned)) return { error: 'Enter an amount like 4500 or 4500.50.' };
  const [whole, cents = ''] = cleaned.split('.');
  return { minor: Number(whole) * 100 + Number(cents.padEnd(2, '0')) };
}

/** minor units → the editor's text ("4500.5" style, no currency). */
export const priceInput = (minor: number | null) =>
  minor === null ? '' : minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);

/** Server refusals in plain words. */
export function marketError(error: unknown): string {
  if (isServiceError(error)) {
    if (/seller profile is suspended/i.test(error.message))
      return 'Your shop is suspended. Contact a community admin.';
    if (/seller profile is paused/i.test(error.message))
      return 'Your shop is paused. Resume it to publish listings.';
    if (/category/i.test(error.message)) return 'Choose a category that matches what you are listing.';
    if (/below the .* reserved/i.test(error.message)) return error.message;
    if (error.code === ErrorCode.Forbidden)
      return "You don't have permission to do that in this marketplace.";
    if (error.code === ErrorCode.NotFound) return 'This listing is no longer available.';
  }
  return errorMessage(error);
}
