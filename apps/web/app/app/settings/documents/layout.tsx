import { Messages } from '@/lib/i18n-scope';

/** Settings → Documents: templates and authorised signatories (16.9, 16.12). */
export default function DocumentSettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'docTpl',
        'docFields',
        'docSignatories',
        'docSend.orderOption',
        'documents.categoryName',
        'locales',
        'roles',
        'reports.enum.employmentType',
        'reports.enum.contractType',
        'reports.enum.payFrequency',
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
