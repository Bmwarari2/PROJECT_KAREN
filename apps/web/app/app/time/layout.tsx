import { Messages } from '@/lib/i18n-scope';

/** Time overview: its own panels, the self-service tiles and who's-out list it shares with Home. */
export default function TimeOverviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'timeOverview',
        'dashboard.you',
        'dashboard.out',
        'timeOff.kind',
        'timeOff.status',
        'timesheets.status',
      ]}
    >
      {children}
    </Messages>
  );
}
