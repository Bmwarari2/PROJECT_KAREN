import type { Metadata, Viewport } from 'next';
import { ToastProvider } from '@thapsus/ui';
import { I18nProvider } from '@/lib/i18n-client';
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
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0b' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, theme, messages, t } = await serverContext();
  return (
    <html lang={locale} data-theme={theme === 'system' ? undefined : theme} suppressHydrationWarning>
      <body className="min-h-dvh bg-bg text-text antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-pill focus:bg-accent focus:px-4 focus:py-2 focus:text-on-accent">
          {t('common.skipToContent')}
        </a>
        <I18nProvider locale={locale} messages={messages}>
          <ToastProvider closeLabel={t('common.close')}>{children}</ToastProvider>
        </I18nProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
