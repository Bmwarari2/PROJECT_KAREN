import { Messages } from '@/lib/i18n-scope';

export default function PayTransparencyLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['compliance.pt']}>{children}</Messages>;
}
