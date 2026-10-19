import { Messages } from '@/lib/i18n-scope';

export default function GalleryLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['gallery']}>{children}</Messages>;
}
