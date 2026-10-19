import { Messages } from '@/lib/i18n-scope';

export default function SsoLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.sso', 'time.opensNewTab']}>{children}</Messages>;
}
