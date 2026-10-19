import { Messages } from '@/lib/i18n-scope';

export default function WorkflowsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.workflows']}>{children}</Messages>;
}
