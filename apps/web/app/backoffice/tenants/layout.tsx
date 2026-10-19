import { Messages } from '@/lib/i18n-scope';

export default function TenantsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['backoffice.tenants', 'backoffice.tenant', 'backoffice.contracts', 'backoffice.flags', 'billing.currency', 'billing.plan', 'billing.po', 'billing.status', 'platform.flags', 'pricing.plans']}>{children}</Messages>;
}
