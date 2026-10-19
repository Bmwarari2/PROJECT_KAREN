import { Messages } from '@/lib/i18n-scope';

export default function ApiLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['platform.api', 'platform.scopes']}>{children}</Messages>;
}
