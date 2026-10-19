import { Messages } from '@/lib/i18n-scope';

export default function UsersLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['access']}>{children}</Messages>;
}
