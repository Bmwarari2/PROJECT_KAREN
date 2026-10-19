import { Messages } from '@/lib/i18n-scope';

export default function DelegationsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.delegations']}>{children}</Messages>;
}
