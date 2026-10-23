import { Messages } from '@/lib/i18n-scope';

export default function SupportLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'backoffice.support',
        'backoffice.tenants',
        'pricing.plans',
        'support.statuses',
        'support.slaStates',
        'support.priority',
        'support.priorities',
        'support.firstResponseDue',
        'support.resolutionDue',
        'support.conversation',
        'support.reference',
        'support.sla',
      ]}
    >
      {children}
    </Messages>
  );
}
