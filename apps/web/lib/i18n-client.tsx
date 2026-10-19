'use client';
import * as React from 'react';
import type { Locale } from '@thapsus/core/i18n';
import { translate } from './i18n-shared';

interface I18nValue {
  locale: Locale;
  messages: Record<string, string>;
}
const NONE: I18nValue = { locale: 'en-GB', messages: {} };
const Ctx = React.createContext<I18nValue>(NONE);

/** Provides messages to client components; a nested provider adds its messages to its parent's (ADR-0150). */
export function I18nProvider({ locale, messages, children }: I18nValue & { children: React.ReactNode }) {
  const parent = React.useContext(Ctx);
  const value = React.useMemo(() => ({ locale, messages: parent === NONE ? messages : { ...parent.messages, ...messages } }), [locale, messages, parent]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT() {
  const { messages } = React.useContext(Ctx);
  return React.useCallback((key: string, vars?: Record<string, string | number>) => translate(messages, key, vars), [messages]);
}

export function useLocale() {
  return React.useContext(Ctx).locale;
}
