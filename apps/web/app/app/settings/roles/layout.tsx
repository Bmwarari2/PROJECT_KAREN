import { Messages } from '@/lib/i18n-scope';

export default function RolesLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'access.roles',
        'access.editor',
        'access.area',
        'access.section',
        'access.perm',
        'access.field',
        'access.errors',
      ]}
    >
      {children}
    </Messages>
  );
}
