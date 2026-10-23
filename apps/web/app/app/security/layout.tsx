import { Messages } from '@/lib/i18n-scope';

export default function SecurityLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['app.security', 'auth.mfa', 'auth.fields.password']}>{children}</Messages>;
}
