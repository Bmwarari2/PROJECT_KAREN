import { Messages } from '@/lib/i18n-scope';

export default function TimeLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.time', 'admin.policy.range', 'rota.location']}>{children}</Messages>;
}
