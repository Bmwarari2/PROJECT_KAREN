import { Messages } from '@/lib/i18n-scope';

export default function ApprovalsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={['approvals', 'people.field', 'admin.delegations.link', 'admin.approvals.field', 'timeOff.kind']}
    >
      {children}
    </Messages>
  );
}
