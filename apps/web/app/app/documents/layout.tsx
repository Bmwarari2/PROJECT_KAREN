import { Messages } from '@/lib/i18n-scope';

export default function DocumentsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['documents', 'listView', 'docView', 'docSign', 'docAttach']}>{children}</Messages>;
}
