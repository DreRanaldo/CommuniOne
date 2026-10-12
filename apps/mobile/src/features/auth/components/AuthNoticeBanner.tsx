import { Banner } from '@/components';
import { useAuth, type AuthNotice } from '../AuthProvider';

const CONTENT: Record<
  AuthNotice['kind'],
  { tone: 'info' | 'success' | 'danger'; title: string; message?: string }
> = {
  sessionExpired: { tone: 'info', title: 'Your session has expired', message: 'Please sign in again.' },
  linkError: { tone: 'danger', title: 'That link did not work' },
  passwordUpdated: {
    tone: 'success',
    title: 'Password updated',
    message: 'Your new password is ready to use.',
  },
  emailConfirmed: { tone: 'success', title: 'Email confirmed', message: 'Welcome to CommuniOne.' },
  accountDeleted: {
    tone: 'info',
    title: 'Your account has been deleted',
    message: 'Thank you for being part of CommuniOne.',
  },
};

/** Shows the current auth notice, if any, with a dismiss button. */
export function AuthNoticeBanner({ only }: { only?: readonly AuthNotice['kind'][] }) {
  const { notice, clearNotice } = useAuth();
  if (!notice || (only && !only.includes(notice.kind))) return null;
  const content = CONTENT[notice.kind];
  const message = notice.kind === 'linkError' ? notice.message : (content.message ?? '');
  return (
    <Banner
      tone={content.tone}
      title={content.title}
      message={message}
      onDismiss={clearNotice}
      testID="auth-notice"
    />
  );
}
