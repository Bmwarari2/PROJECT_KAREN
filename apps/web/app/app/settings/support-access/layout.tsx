import { Messages } from '@/lib/i18n-scope';

export default function SupportAccessLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.support']}>{children}</Messages>;
}
