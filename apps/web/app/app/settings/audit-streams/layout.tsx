import { Messages } from '@/lib/i18n-scope';

export default function AuditStreamsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['platform.streams', 'platform.webhooks', 'platform.api.name']}>{children}</Messages>;
}
