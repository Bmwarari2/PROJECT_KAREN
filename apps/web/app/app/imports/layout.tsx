import { Messages } from '@/lib/i18n-scope';

export default function ImportsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['imports', 'people.field']}>{children}</Messages>;
}
