import { Messages } from '@/lib/i18n-scope';

export default function CalendarsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.calendars', 'admin.leave.everyone', 'admin.leave.entity', 'rota.location', 'rota.allLocations']}>{children}</Messages>;
}
