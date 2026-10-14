// Booking times in the app: CommuniOne's sellers are in Jamaica, which has
// no daylight saving (UTC-05:00 all year), so local times are built with a
// fixed offset. The server checks every time again.

export const JAMAICA_OFFSET = '-05:00';

/** The next `n` local dates as YYYY-MM-DD, starting tomorrow. */
export function nextDates(n: number, now = Date.now()): string[] {
  const local = new Date(now - 5 * 3_600_000);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i + 1));
    return d.toISOString().slice(0, 10);
  });
}

/** Weekday (0 = Sunday) of a local date. */
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Local date + "HH:MM" -> ISO instant. */
export const localToIso = (date: string, time: string) =>
  new Date(`${date}T${time}:00${JAMAICA_OFFSET}`).toISOString();

/** ISO instant -> "Mon 20 Oct, 10:00" in Jamaica time. */
export function formatLocal(iso: string): string {
  const d = new Date(Date.parse(iso) - 5 * 3_600_000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${hh}:${mm}`;
}

export const dateLabel = (date: string) => formatLocal(`${date}T17:00:00Z`).split(',')[0]!;

/**
 * Whole-hour start times for a date: inside the seller's windows (any time
 * 08:00-18:00 when they set none), the booking fitting entirely, and not
 * overlapping busy periods.
 */
export function startTimes(
  date: string,
  hours: number,
  windows: { weekday: number; start: string; end: string }[],
  busy: { startsAt: string; endsAt: string }[],
): string[] {
  const day = weekdayOf(date);
  const ranges = windows.length
    ? windows.filter((w) => w.weekday === day)
    : [{ start: '08:00', end: '18:00' }];
  const out: string[] = [];
  for (let h = 0; h + hours <= 24; h += 1) {
    const start = `${String(h).padStart(2, '0')}:00`;
    const end = `${String(h + hours).padStart(2, '0')}:00`;
    if (!ranges.some((r) => start >= r.start && (h + hours === 24 ? '24:00' : end) <= r.end)) continue;
    const s = Date.parse(localToIso(date, start));
    const e = s + hours * 3_600_000;
    if (busy.some((b) => Date.parse(b.startsAt) < e && Date.parse(b.endsAt) > s)) continue;
    out.push(start);
  }
  return out;
}
