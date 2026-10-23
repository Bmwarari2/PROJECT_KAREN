import { Messages } from '@/lib/i18n-scope';

export default function ScimLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.scim']}>{children}</Messages>;
}
