import { Messages } from '@/lib/i18n-scope';

export default function PeopleLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['people']}>{children}</Messages>;
}
