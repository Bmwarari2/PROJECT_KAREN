import { Messages } from '@/lib/i18n-scope';

export default function RulesLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['backoffice.rules']}>{children}</Messages>;
}
