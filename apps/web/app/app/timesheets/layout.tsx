import { Messages } from '@/lib/i18n-scope';

export default function TimesheetsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'timesheets',
        'time',
        'clock.noEmployee',
        'rota.weekNav',
        'rota.prevWeek',
        'rota.weekOf',
        'rota.nextWeek',
        'actionable.timesheet',
      ]}
    >
      {children}
    </Messages>
  );
}
