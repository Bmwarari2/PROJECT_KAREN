import type * as React from 'react';
import { I18nProvider } from './i18n-client';
import { scopedMessages } from './i18n';
import { serverContext } from './server';

/**
 * Gives the client components of this route segment the catalogue namespaces they use, on top of
 * what the layouts above provide (ADR-0150). Entries: `ns` (every key under it), `ns.*` (only the
 * messages directly in `ns`) or a full key. Keep the list inline as string literals:
 * `scripts/test/i18n-scopes.test.ts` reads it and fails when a page uses a key its layouts do not provide.
 */
export async function Messages({ ns, children }: { ns: readonly string[]; children: React.ReactNode }) {
  const { locale } = await serverContext();
  return (
    <I18nProvider locale={locale} messages={scopedMessages(locale, ns)}>
      {children}
    </I18nProvider>
  );
}
