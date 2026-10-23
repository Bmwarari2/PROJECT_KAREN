import { Messages } from '@/lib/i18n-scope';

export default function UsersLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages ns={['access', 'listView', 'app.security.stepUp', 'auth.fields.password', 'auth.mfa']}>
      {children}
    </Messages>
  );
}
