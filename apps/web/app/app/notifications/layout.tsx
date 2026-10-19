import { Messages } from '@/lib/i18n-scope';

export default function NotificationsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['app.notifications', 'ess.notifications']}>{children}</Messages>;
}
