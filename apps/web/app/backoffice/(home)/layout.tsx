import { Messages } from '@/lib/i18n-scope';

export default function BackofficeHomeLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['backoffice.metrics', 'billing.status', 'pricing.plans']}>{children}</Messages>;
}
