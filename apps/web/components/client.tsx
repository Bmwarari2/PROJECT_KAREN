'use client';
import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useT, useLocale } from '@/lib/i18n-client';
import { LOCALE_COOKIE, THEME_COOKIE, type ThemeChoice } from '@/lib/i18n-shared';

const setCookie = (name: string, value: string) => {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
};

/** Applies and remembers a theme choice (cookie read on the server, so the next page has no flash). */
export function applyTheme(v: ThemeChoice) {
  setCookie(THEME_COOKIE, v);
  if (v === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
}

/** Switches the interface language and reloads, because the server picks the message catalogue. */
export function switchLocale(v: string) {
  setCookie(LOCALE_COOKIE, v);
  window.location.reload();
}

export function ThemeSwitch({ initial }: { initial: ThemeChoice }) {
  const t = useT();
  const [choice, setChoice] = React.useState<ThemeChoice>(initial);
  const options: Array<{ v: ThemeChoice; icon: React.ReactNode; label: string }> = [
    {
      v: 'system',
      icon: <Monitor aria-hidden className="h-4 w-4 stroke-[1.5]" />,
      label: t('common.themeSystem'),
    },
    { v: 'light', icon: <Sun aria-hidden className="h-4 w-4 stroke-[1.5]" />, label: t('common.themeLight') },
    { v: 'dark', icon: <Moon aria-hidden className="h-4 w-4 stroke-[1.5]" />, label: t('common.themeDark') },
  ];
  const apply = (v: ThemeChoice) => {
    setChoice(v);
    applyTheme(v);
  };
  return (
    <div
      role="radiogroup"
      aria-label={t('common.theme')}
      className="inline-flex rounded-pill bg-surface p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={choice === o.v}
          aria-label={o.label}
          title={o.label}
          onClick={() => apply(o.v)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-pill text-text-secondary aria-checked:bg-surface-raised aria-checked:text-text aria-checked:shadow-sm"
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

export function LocaleSwitch() {
  const t = useT();
  const locale = useLocale();
  return (
    <label className="inline-flex items-center gap-2 text-footnote text-text-secondary">
      <span className="sr-only">{t('common.language')}</span>
      <select
        value={locale}
        onChange={(e) => switchLocale(e.target.value)}
        className="h-8 rounded-sm border border-border bg-surface-raised px-2 text-footnote text-text"
      >
        <option value="en-GB">{t('locales.en-GB')}</option>
        <option value="en-US">{t('locales.en-US')}</option>
      </select>
    </label>
  );
}

/** Scroll-triggered reveal. Content is visible without JS and under reduced motion. */
export function Reveal({
  children,
  as: Tag = 'div',
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  as?: 'div' | 'li' | 'section';
  className?: string;
  delay?: number;
}) {
  const ref = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (
      !el ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !('IntersectionObserver' in window)
    )
      return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight) return; // already on screen: never hide it
    el.dataset.reveal = 'pending';
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).style.transitionDelay = `${delay}ms`;
            (e.target as HTMLElement).dataset.reveal = 'shown';
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [delay]);
  return React.createElement(Tag, { ref, className }, children);
}

/** Registers the service worker in production builds. */
export function ServiceWorkerRegister() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
