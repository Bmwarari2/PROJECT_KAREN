import { Messages } from '@/lib/i18n-scope';

export default function SigninLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['backoffice.signin']}>{children}</Messages>;
}
