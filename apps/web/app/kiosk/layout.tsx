import type { Metadata } from 'next';
import { serverContext } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverContext();
  return { title: t('kiosk.title'), robots: { index: false, follow: false } };
}

export default function KioskLayout({ children }: { children: React.ReactNode }) {
  return children;
}
