import { Messages } from '@/lib/i18n-scope';

export default function LawChangesLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['compliance.law']}>{children}</Messages>;
}
