import { Messages } from '@/lib/i18n-scope';

export default function PeopleLayout({ children }: { children: React.ReactNode }) {
  // the directory names the permission it needs when the viewer lacks it
  return (
    <Messages ns={['people', 'access.perm.employees.read', 'reports.enum.employmentType']}>
      {children}
    </Messages>
  );
}
