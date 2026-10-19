import { Messages } from '@/lib/i18n-scope';

export default function OrgChartLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['org']}>{children}</Messages>;
}
