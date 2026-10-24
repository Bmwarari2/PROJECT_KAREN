import { Messages } from '@/lib/i18n-scope';

export default function AccessLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['backoffice.elevation', 'backoffice.stepUp']}>{children}</Messages>;
}
