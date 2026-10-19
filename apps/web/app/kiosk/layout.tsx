import type { Metadata } from 'next';
import { Messages } from '@/lib/i18n-scope';
import { serverContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverContext();
  return { title: t('kiosk.title'), robots: { index: false, follow: false } };
}

export default function KioskLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['kiosk', 'clock.kind', 'clock.in', 'clock.out', 'clock.breakStart', 'clock.breakEnd']}>{children}</Messages>;
}
