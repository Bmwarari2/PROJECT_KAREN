import { Messages } from '@/lib/i18n-scope';

export default function WelcomeLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['onboarding', 'documents.sign', 'documents.signTitle', 'people.field']}>{children}</Messages>;
}
