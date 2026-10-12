import { isKnownTimeZone, slugFor, validateCreateCommunity } from './validation';

const valid = {
  name: 'Maple Grove',
  description: '',
  type: 'residential' as const,
  timezone: 'America/Chicago',
};

describe('slugFor', () => {
  const fixed = () => 0;
  test('lowercase words joined by dashes, accents removed, random suffix', () => {
    expect(slugFor('Maple Grove HOA', fixed)).toBe('maple-grove-hoa-aaaa');
    expect(slugFor('  Café — Société!  ', fixed)).toBe('cafe-societe-aaaa');
    expect(slugFor('St. Mark’s Choir', fixed)).toBe('st-mark-s-choir-aaaa');
  });
  test('always a valid database slug, even for names without letters', () => {
    for (const name of ['教会', '!!!', 'x', 'a'.repeat(200)]) {
      const slug = slugFor(name);
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slug.length).toBeGreaterThanOrEqual(3);
      expect(slug.length).toBeLessThanOrEqual(63);
    }
    expect(slugFor('教会', fixed)).toBe('community-aaaa');
  });
  test('two calls differ (unique addresses without asking the user)', () => {
    expect(slugFor('Maple Grove')).not.toBe(slugFor('Maple Grove'));
  });
});

describe('validateCreateCommunity', () => {
  test('a complete form is valid', () => {
    expect(validateCreateCommunity(valid)).toEqual({});
  });
  test('name, description, type and time zone are checked', () => {
    expect(validateCreateCommunity({ ...valid, name: '   ' }).name).toBe('Enter a name for your community.');
    expect(validateCreateCommunity({ ...valid, name: 'x'.repeat(121) }).name).toBe(
      'Use at most 120 characters.',
    );
    expect(validateCreateCommunity({ ...valid, description: 'x'.repeat(2001) }).description).toBeDefined();
    // @ts-expect-error not a community type
    expect(validateCreateCommunity({ ...valid, type: 'castle' }).type).toBeDefined();
    expect(validateCreateCommunity({ ...valid, timezone: '' }).timezone).toBe('Enter a time zone.');
    expect(validateCreateCommunity({ ...valid, timezone: 'Not/A_Zone' }).timezone).toBeDefined();
    expect(validateCreateCommunity({ ...valid, timezone: 'drop table' }).timezone).toBeDefined();
  });
  test('known time zones', () => {
    expect(isKnownTimeZone('Europe/London')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});
