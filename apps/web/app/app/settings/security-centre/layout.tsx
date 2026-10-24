import { Messages } from '@/lib/i18n-scope';

export default function SecurityCentreLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages ns={['admin.securityCentre', 'backoffice.security.rules', 'backoffice.security.severity']}>
      {children}
    </Messages>
  );
}
