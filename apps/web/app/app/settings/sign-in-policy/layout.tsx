import { Messages } from '@/lib/i18n-scope';

export default function SignInPolicyLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.policy']}>{children}</Messages>;
}
