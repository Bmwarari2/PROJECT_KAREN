import { Messages } from '@/lib/i18n-scope';

export default function RotaLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['rota', 'time']}>{children}</Messages>;
}
