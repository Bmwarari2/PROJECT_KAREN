import { Messages } from '@/lib/i18n-scope';

export default function SandboxLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['platform.sandbox']}>{children}</Messages>;
}
