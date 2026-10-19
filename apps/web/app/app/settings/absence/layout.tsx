import { Messages } from '@/lib/i18n-scope';

export default function AbsenceLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.absence', 'admin.leave.everyone', 'rota.location', 'rota.allLocations']}>{children}</Messages>;
}
