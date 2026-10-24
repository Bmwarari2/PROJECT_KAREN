import { Messages } from '@/lib/i18n-scope';

export default function MeLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages ns={['ess', 'people.field', 'people.effectiveDate', 'people.section', 'reports.enum']}>
      {children}
    </Messages>
  );
}
