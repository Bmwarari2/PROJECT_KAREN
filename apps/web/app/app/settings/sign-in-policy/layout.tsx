import { Messages } from '@/lib/i18n-scope';

export default function SignInPolicyLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.policy', 'app.security.stepUp', 'auth.fields.password', 'auth.mfa']}>{children}</Messages>;
}
