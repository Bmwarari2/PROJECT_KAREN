import { Messages } from '@/lib/i18n-scope';

export default function UsersLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['access', 'app.security.stepUp', 'auth.fields.password', 'auth.mfa']}>{children}</Messages>;
}
