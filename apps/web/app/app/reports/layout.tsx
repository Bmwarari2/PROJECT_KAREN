import { Messages } from '@/lib/i18n-scope';

// Report definitions, columns, facts, notes and enum values come from the API as message keys, so the
// whole `reports` namespace and the compliance groups the ready-made reports use are provided here.
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'reports',
        'compliance.gpg',
        'compliance.pt',
        'compliance.job',
        'compliance.race',
        'compliance.sex',
        'compliance.ptStatus',
        'compliance.status',
        'compliance.dashboard',
        'compliance.band',
      ]}
    >
      {children}
    </Messages>
  );
}
