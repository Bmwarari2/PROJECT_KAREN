import { Messages } from '@/lib/i18n-scope';

export default function BillingLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['billing', 'pricing.plans', 'pricing.term']}>{children}</Messages>;
}
