import { Messages } from '@/lib/i18n-scope';

export default function DocumentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'documents',
        'listView',
        'docView',
        'docSign',
        'docAttach',
        'docStatus',
        'docSignature',
        'docSend',
        'docBulk',
        'admin.optional',
        'admin.readOnly',
        'app.security.stepUp',
        'auth.fields.password',
        'auth.mfa.codeLabel',
        'auth.mfa.codeHint',
      ]}
    >
      {children}
    </Messages>
  );
}
