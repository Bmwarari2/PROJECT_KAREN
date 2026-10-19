import { Messages } from '@/lib/i18n-scope';

export default function MatrixLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['compliance.matrix', 'compliance.kind']}>{children}</Messages>;
}
