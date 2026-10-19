import { Messages } from '@/lib/i18n-scope';

export default function AskHrLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['askHr.settings', 'askHr.errors']}>{children}</Messages>;
}
