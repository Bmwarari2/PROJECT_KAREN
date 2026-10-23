'use client';
import * as React from 'react';
import { useT } from '@/lib/i18n-client';
import { PageIntro } from '@/components/module-page';

/**
 * Privacy and trust area for administrators: requests, retention, incidents, legal and account data.
 * The module header and its tab bar (the shell) name the area and its sections; the frame keeps the
 * lead that explains it.
 */
export function PrivacyFrame({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <PageIntro title={t('privacy.ui.title')} titleIsTab lead={t('privacy.ui.lead')} />
      {children}
    </div>
  );
}
