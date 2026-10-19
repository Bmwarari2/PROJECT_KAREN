import { Messages } from '@/lib/i18n-scope';

export default function AskLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['askHr']}>{children}</Messages>;
}
