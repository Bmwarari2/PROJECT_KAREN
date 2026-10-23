import { Messages } from '@/lib/i18n-scope';

export default function ComplianceLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'compliance.*',
        'compliance.nav',
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
      {/* the module's tab bar (the shell) is the compliance navigation */}
      <div className="flex flex-col gap-6">{children}</div>
    </Messages>
  );
}
