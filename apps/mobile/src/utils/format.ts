/** A readable date in the user's locale (e.g. "12 Oct 2026"), or an em dash. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function format(date: Date, options: Intl.DateTimeFormatOptions, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(date);
  } catch {
    // Unknown time zone on this device: fall back to the device's own.
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

/** Day and time, e.g. "Sat, 14 Nov, 18:00", in `timeZone` (a community's) when given. */
export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return format(
    date,
    { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
    timeZone,
  );
}

/** Time of day, e.g. "14:05" (when data was last loaded). */
export function formatTime(epochMs: number): string {
  return format(new Date(epochMs), { hour: 'numeric', minute: '2-digit' });
}
