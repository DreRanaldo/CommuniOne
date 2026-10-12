// Client-side checks for the profile form, mirroring the database limits
// (names ≤ 100, bio ≤ 1000, phone format). The service layer and the
// database re-check everything.

export interface ProfileForm {
  displayName: string;
  firstName: string;
  lastName: string;
  bio: string;
  phone: string;
}

export type ProfileFormErrors = Partial<Record<keyof ProfileForm, string>>;

const PHONE = /^\+?[0-9 ().-]{5,32}$/;
const length = (value: string) => [...value.trim()].length;

export function validateProfileForm(form: ProfileForm): ProfileFormErrors {
  const errors: ProfileFormErrors = {};
  if (length(form.displayName) > 100) errors.displayName = 'Use at most 100 characters.';
  if (length(form.firstName) > 100) errors.firstName = 'Use at most 100 characters.';
  if (length(form.lastName) > 100) errors.lastName = 'Use at most 100 characters.';
  if (length(form.bio) > 1000) errors.bio = 'Use at most 1000 characters.';
  const phone = form.phone.trim();
  if (phone && !PHONE.test(phone))
    errors.phone = 'Use digits, spaces and + ( ) . - only (5 to 32 characters).';
  return errors;
}
