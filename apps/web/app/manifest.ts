import type { MetadataRoute } from 'next';
import { colors } from '@thapsus/ui/tokens';
import { serverContext } from '@/lib/server';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { t } = await serverContext();
  return {
    id: '/app',
    name: t('common.appName'),
    short_name: t('common.appName'),
    description: t('marketing.meta.description'),
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    background_color: colors.bg.light,
    theme_color: colors.accent.light,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
