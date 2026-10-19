import { Messages } from '@/lib/i18n-scope';

export default function AutomationLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['automation']}>{children}</Messages>;
}
