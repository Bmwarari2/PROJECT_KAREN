import { Messages } from '@/lib/i18n-scope';

export default function DomainsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.domains']}>{children}</Messages>;
}
