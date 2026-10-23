import { Messages } from '@/lib/i18n-scope';

/** Home dashboard: its widgets and the labels it shows for leave kinds, statuses and employment types. */
export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages ns={['dashboard', 'timeOff.kind', 'timeOff.status', 'reports.enum.employmentType']}>
      {children}
    </Messages>
  );
}
