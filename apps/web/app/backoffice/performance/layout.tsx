import { Messages } from '@/lib/i18n-scope';

export default function PerformanceLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['backoffice.performance', 'statusPage.postStatus']}>{children}</Messages>;
}
