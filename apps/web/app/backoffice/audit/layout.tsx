import { Messages } from '@/lib/i18n-scope';

export default function AuditLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['backoffice.audit']}>{children}</Messages>;
}
