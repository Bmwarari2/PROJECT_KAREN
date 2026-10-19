import { Messages } from '@/lib/i18n-scope';

export default function OrganisationLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['orgSettings']}>{children}</Messages>;
}
