import { Messages } from '@/lib/i18n-scope';

export default function BrandingLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['platform.branding']}>{children}</Messages>;
}
