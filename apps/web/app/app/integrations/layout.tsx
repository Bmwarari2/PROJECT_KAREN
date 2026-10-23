import { Messages } from '@/lib/i18n-scope';

export default function IntegrationsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['integrations', 'listView']}>{children}</Messages>;
}
