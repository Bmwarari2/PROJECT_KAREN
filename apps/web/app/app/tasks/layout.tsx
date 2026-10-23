import { Messages } from '@/lib/i18n-scope';

export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['tasks']}>{children}</Messages>;
}
