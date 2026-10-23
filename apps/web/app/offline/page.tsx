import { WifiOff } from 'lucide-react';
import { EmptyState } from '@thapsus/ui';
import { serverContext } from '@/lib/server';

/** Precached by the service worker and shown when a navigation fails offline. */
export default async function Offline() {
  const { t } = await serverContext();
  return (
    <main id="main" className="mx-auto max-w-[var(--prose-width)] px-4 py-24">
      <EmptyState level={1} icon={<WifiOff aria-hidden />} title={t('offline.title')} body={t('offline.body')} />
    </main>
  );
}
