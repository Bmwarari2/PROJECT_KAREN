import { Messages } from '@/lib/i18n-scope';

export default function ClockLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['clock', 'rota.location', 'rota.allLocations']}>{children}</Messages>;
}
