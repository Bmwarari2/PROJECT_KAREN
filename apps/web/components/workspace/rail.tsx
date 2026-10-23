'use client';
import * as React from 'react';
import Link from 'next/link';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { GROUPS, type VisibleModule } from '@/app/app/workspace';

/**
 * The app rail: modules grouped by area (You, Workforce, Insights, Governance, Company), with Help at
 * the foot. Each entry opens the module's first tab the viewer may see; the tab bar does the rest.
 * Collapsed, it shows icons only (each still has its name), and the choice is remembered on this device.
 */
export function RailNav({
  modules,
  currentKey,
  collapsed = false,
  counts = {},
  onNavigate,
}: {
  modules: VisibleModule[];
  currentKey: string | null;
  collapsed?: boolean;
  counts?: Record<string, number>;
  onNavigate?: () => void;
}) {
  const t = useT();
  const sections = [
    { key: 'home', items: modules.filter((m) => m.group === 'home') },
    ...GROUPS.filter((g) => g !== 'support').map((g) => ({
      key: g,
      items: modules.filter((m) => m.group === g),
    })),
    { key: 'support', items: modules.filter((m) => m.group === 'support') },
  ].filter((s) => s.items.length);
  return (
    <nav aria-label={t('app.nav.label')} className="flex flex-col gap-4">
      {sections.map((section) => (
        <div key={section.key} className="flex flex-col gap-0.5">
          {section.key !== 'home' && section.key !== 'support' ? (
            collapsed ? (
              <span aria-hidden className="mx-3 my-1 block h-px bg-border" />
            ) : (
              <p className="px-3 pb-1 text-footnote font-semibold text-text-secondary">
                {t(`app.ws.group.${section.key}`)}
              </p>
            )
          ) : section.key === 'support' ? (
            <span aria-hidden className="mx-3 mb-1 block h-px bg-border" />
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {section.items.map((m) => {
              const active = m.key === currentKey;
              const Icon = m.icon;
              const count = counts[m.key] ?? 0;
              const name = t(m.label);
              return (
                <li key={m.key}>
                  <Link
                    href={m.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    aria-label={collapsed ? (count ? `${name} (${count})` : name) : undefined}
                    title={collapsed ? name : undefined}
                    className={cn(
                      'relative flex h-10 items-center gap-3 rounded-md px-3 text-callout no-underline transition-colors duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:outline-accent',
                      collapsed && 'justify-center px-0',
                      active
                        ? 'bg-accent-subtle font-semibold text-text'
                        : 'text-text-secondary hover:bg-surface hover:text-text',
                    )}
                  >
                    <Icon aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5]" />
                    {collapsed ? null : <span className="min-w-0 flex-1 truncate">{name}</span>}
                    {count ? (
                      collapsed ? (
                        <span aria-hidden className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent" />
                      ) : (
                        <span className="rounded-full bg-accent px-1.5 text-footnote tabular-nums text-on-accent">
                          <span className="sr-only">{t('app.ws.pending')} </span>
                          {count}
                        </span>
                      )
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

const COLLAPSE_KEY = 'thr.rail.collapsed';

export function useRailCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      // storage blocked: the rail stays expanded
    }
  }, []);
  const set = (v: boolean) => {
    setCollapsed(v);
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      // not remembered, still applied
    }
  };
  return [collapsed, set];
}

export function RailToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const t = useT();
  const label = collapsed ? t('app.ws.expandRail') : t('app.ws.collapseRail');
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      aria-expanded={!collapsed}
      className={cn(
        'flex h-10 items-center gap-3 rounded-md px-3 text-callout text-text-secondary hover:bg-surface hover:text-text focus-visible:outline-2 focus-visible:outline-accent',
        collapsed && 'justify-center px-0',
      )}
    >
      {collapsed ? (
        <PanelLeftOpen aria-hidden className="h-5 w-5 stroke-[1.5]" />
      ) : (
        <PanelLeftClose aria-hidden className="h-5 w-5 stroke-[1.5]" />
      )}
      {collapsed ? null : <span>{t('app.ws.collapseRail')}</span>}
    </button>
  );
}
