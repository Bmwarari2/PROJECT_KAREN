import { Messages } from '@/lib/i18n-scope';

export default function GenderPayGapLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['compliance.gpg', 'compliance.band']}>{children}</Messages>;
}
