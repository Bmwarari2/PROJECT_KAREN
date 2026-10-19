import type { Metadata, Viewport } from 'next';
import { ToastProvider } from '@thapsus/ui';
import { colors } from '@thapsus/ui/tokens';
import { Messages } from '@/lib/i18n-scope';
import { serverContext } from '@/lib/server';
import { ServiceWorkerRegister } from '@/components/client';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverContext();
  return {
    title: { default: t('common.appName'), template: `%s · ${t('common.appName')}` },
    description: t('marketing.meta.description'),
    applicationName: t('common.appName'),
    manifest: '/manifest.webmanifest',
    icons: { icon: '/icons/icon.svg', apple: '/icons/icon-192.png' },
    appleWebApp: { capable: true, title: t('common.appName'), statusBarStyle: 'default' },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: colors.bg.light },
    { media: '(prefers-color-scheme: dark)', color: colors.bg.dark },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, theme, t } = await serverContext();
  return (
    <html lang={locale} data-theme={theme === 'system' ? undefined : theme} suppressHydrationWarning>
      <body className="min-h-dvh bg-bg text-text antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-pill focus:bg-accent focus:px-4 focus:py-2 focus:text-on-accent">
          {t('common.skipToContent')}
        </a>
        {/* only the shared namespaces; each route segment's layout adds what its pages use (ADR-0150) */}
        <Messages ns={['common', 'errors', 'locales', 'regions', 'roles']}>
          <ToastProvider closeLabel={t('common.close')}>{children}</ToastProvider>
        </Messages>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
