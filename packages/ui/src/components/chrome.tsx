import * as React from 'react';
import { cn } from './primitives';

/** App sidebar navigation (desktop); the app renders the same items inside a Sheet below lg. */
export interface NavItem {
  href: string;
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
}

export function SidebarNav({
  items,
  label,
  renderLink,
}: {
  items: NavItem[];
  label: string;
  renderLink?: (item: NavItem, className: string, children: React.ReactNode) => React.ReactNode;
}) {
  return (
    <nav aria-label={label} className="flex flex-col gap-0.5">
      {items.map((item) => {
        const className = cn(
          'flex h-9 items-center gap-3 rounded-md px-3 text-callout transition-colors duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:outline-accent [&_svg]:h-5 [&_svg]:w-5 [&_svg]:stroke-[1.5]',
          item.active
            ? 'bg-accent-subtle font-semibold text-text'
            : 'text-text-secondary hover:bg-surface-raised hover:text-text',
        );
        const children = (
          <>
            {item.icon}
            <span className="truncate">{item.label}</span>
          </>
        );
        return (
          <React.Fragment key={item.href}>
            {renderLink ? (
              renderLink(item, className, children)
            ) : (
              <a href={item.href} className={className} aria-current={item.active ? 'page' : undefined}>
                {children}
              </a>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/**
 * Sticky, full viewport height and scrolls on its own, so the page height never depends on how many
 * entries a user's navigation has. scroll-padding keeps a focused entry (and its focus ring) clear of
 * the edges when Tab moves into the part that is scrolled out of view.
 */
export function Sidebar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-dvh w-[var(--sidebar-width)] shrink-0 scroll-py-4 flex-col gap-6 self-start overflow-y-auto overscroll-contain border-r border-border bg-surface px-3 py-4 lg:flex',
        className,
      )}
    >
      {children}
    </aside>
  );
}

/**
 * App top bar: sticky and opaque. The translucent blur belongs to the marketing nav; in the app it
 * cost a composited backdrop filter on every scroll on low-cost phones and made text in the bar
 * rasterise differently from run to run.
 */
export function TopBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-[var(--topbar-height)] items-center gap-3 border-b border-border bg-bg px-4 md:px-6',
        className,
      )}
    >
      {children}
    </header>
  );
}

/** Marketing nav: slim, sticky, translucent and blurred. */
export function MarketingNav({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        'sticky top-0 z-40 h-[var(--nav-height)] border-b border-border/60 bg-bg/72 backdrop-blur-[20px] backdrop-saturate-[180%] supports-[not(backdrop-filter:blur(1px))]:bg-bg',
        className,
      )}
    >
      <div className="mx-auto flex h-full max-w-[var(--content-width)] items-center gap-6 px-4 md:px-6">
        {children}
      </div>
    </header>
  );
}

/** Full-width section that alternates tone; `tone="inverse"` gives the dark contrast band. */
export function Section({
  tone = 'bg',
  className,
  children,
  id,
  labelledBy,
}: {
  tone?: 'bg' | 'surface' | 'inverse';
  className?: string;
  children: React.ReactNode;
  id?: string;
  labelledBy?: string;
}) {
  const toneClass = {
    bg: 'bg-bg text-text',
    surface: 'bg-surface text-text',
    inverse: 'bg-surface-inverse text-text-inverse',
  }[tone];
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      data-tone={tone}
      className={cn('w-full px-4 py-20 md:px-6 md:py-28', toneClass, className)}
    >
      <div className="mx-auto max-w-[var(--content-width)]">{children}</div>
    </section>
  );
}
