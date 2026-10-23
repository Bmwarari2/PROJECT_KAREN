import { Messages } from '@/lib/i18n-scope';

export default function PlansLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['backoffice.plans', 'backoffice.contracts', 'backoffice.tenant', 'backoffice.tenants', 'billing.currency', 'billing.plan', 'billing.term', 'pricing.bands', 'pricing.plans', 'pricing.term', 'admin.tableScroll']}>{children}</Messages>;
}
