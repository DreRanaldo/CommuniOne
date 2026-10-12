// Client-side checks for auth forms: instant, field-level feedback. They
// mirror the Auth policy (8–72 characters, letters and digits) and the
// service layer re-checks everything; Supabase Auth has the final say.

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function emailError(value: string): string | undefined {
  if (!value.trim()) return 'Enter your email address.';
  if (!EMAIL.test(value.trim())) return 'Enter a valid email address.';
  return undefined;
}

export function newPasswordError(value: string): string | undefined {
  if (value.length < 8) return 'Use at least 8 characters.';
  if (value.length > 72) return 'Use at most 72 characters.';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return 'Use both letters and numbers.';
  return undefined;
}

export function confirmError(password: string, confirmation: string): string | undefined {
  return password === confirmation ? undefined : 'The passwords do not match.';
}

export const hasErrors = (errors: Record<string, string | undefined>): boolean =>
  Object.values(errors).some(Boolean);
