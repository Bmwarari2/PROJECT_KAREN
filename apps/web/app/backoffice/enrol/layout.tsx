import { Messages } from '@/lib/i18n-scope';

export default function EnrolLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['backoffice.enrol', 'backoffice.signin']}>{children}</Messages>;
}
