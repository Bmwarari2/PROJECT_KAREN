import { Messages } from '@/lib/i18n-scope';

export default function ContactHrLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['actionable.hr', 'taskActions.hrReply']}>{children}</Messages>;
}
