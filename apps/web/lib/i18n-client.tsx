'use client';
import * as React from 'react';
import type { Locale } from '@thapsus/core/i18n';
import { translate } from './i18n-shared';

interface I18nValue {
  locale: Locale;
  messages: Record<string, string>;
}
const Ctx = React.createContext<I18nValue>({ locale: 'en-GB', messages: {} });

export function I18nProvider({ locale, messages, children }: I18nValue & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ locale, messages }), [locale, messages]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT() {
  const { messages } = React.useContext(Ctx);
  return React.useCallback((key: string, vars?: Record<string, string | number>) => translate(messages, key, vars), [messages]);
}

export function useLocale() {
  return React.useContext(Ctx).locale;
}
