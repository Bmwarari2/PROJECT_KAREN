import { Messages } from '@/lib/i18n-scope';

export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['backoffice.status', 'statusPage.components', 'statusPage.postStatus']}>{children}</Messages>;
}
