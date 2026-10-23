import { Messages } from '@/lib/i18n-scope';

export default function WebhooksLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['platform.webhooks']}>{children}</Messages>;
}
