import { Messages } from '@/lib/i18n-scope';

export default function I9Layout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['compliance.i9']}>{children}</Messages>;
}
