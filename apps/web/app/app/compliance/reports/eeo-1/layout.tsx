import { Messages } from '@/lib/i18n-scope';

export default function Eeo1Layout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['compliance.eeo1', 'compliance.job', 'compliance.race', 'compliance.sex']}>{children}</Messages>;
}
