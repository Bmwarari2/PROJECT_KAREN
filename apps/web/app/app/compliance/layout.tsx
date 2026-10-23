import { Messages } from '@/lib/i18n-scope';
import { ComplianceNav } from './ui';

export default function ComplianceLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'compliance.*',
        'compliance.nav',
        'compliance.subnav',
        'compliance.status',
        'compliance.col',
        'compliance.dashboard',
        'compliance.coverage',
        'compliance.flsa',
        'compliance.alert',
        'compliance.period',
        'compliance.ptStatus',
      ]}
    >
      <div className="flex flex-col gap-6">
        <ComplianceNav />
        {children}
      </div>
    </Messages>
  );
}
