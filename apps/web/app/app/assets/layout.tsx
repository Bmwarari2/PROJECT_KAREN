import { Messages } from '@/lib/i18n-scope';

export default function AssetsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['assets', 'listView']}>{children}</Messages>;
}
