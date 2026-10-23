import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from './primitives';

/**
 * Workspace building blocks (DESIGN.md §6): menus, popovers, the module header and its tab bar,
 * and the toolbar above data tables. Token-only styling; Radix supplies keyboard and focus handling.
 */

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuGroup = MenuPrimitive.Group;

export function MenuContent({
  className,
  align = 'end',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[220px] rounded-[var(--radius-md)] border border-border bg-surface-raised p-1 text-text shadow-lg',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function MenuItem({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Item>) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex min-h-10 cursor-default select-none items-center gap-3 rounded-sm px-3 text-callout outline-none data-[highlighted]:bg-surface [&_svg]:h-4 [&_svg]:w-4 [&_svg]:stroke-[1.5]',
        className,
      )}
      {...props}
    />
  );
}

export const MenuRadioGroup = MenuPrimitive.RadioGroup;

export function MenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        'flex min-h-10 cursor-default select-none items-center gap-3 rounded-sm px-3 text-callout outline-none data-[highlighted]:bg-surface [&_svg]:h-4 [&_svg]:w-4 [&_svg]:stroke-[1.5]',
        className,
      )}
      {...props}
    >
      <span className="inline-flex h-4 w-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <span aria-hidden className="block h-2 w-2 rounded-full bg-accent" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

export function MenuLabel({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn('px-3 py-2 text-footnote text-text-secondary', className)}
      {...props}
    />
  );
}

export function MenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('my-1 h-px bg-border', className)} {...props} />;
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-[min(320px,calc(100vw-32px))] rounded-[var(--radius-md)] border border-border bg-surface-raised p-3 text-text shadow-lg',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

/** One tab of a module's tab bar. */
export interface TabLink {
  href: string;
  label: string;
  active: boolean;
  /** Small count shown after the label (pending items). */
  count?: number;
}

/**
 * A module's tab bar: page links with an underline on the current one, scrolling sideways on narrow
 * screens. A navigation landmark (not ARIA tabs), because each tab is its own page.
 */
export function TabNav({
  tabs,
  label,
  renderLink,
  className,
}: {
  tabs: TabLink[];
  label: string;
  renderLink?: (tab: TabLink, className: string, children: React.ReactNode) => React.ReactNode;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn('-mb-px overflow-x-auto', className)}>
      <ul className="flex min-w-max gap-1">
        {tabs.map((tab) => {
          const cls = cn(
            'inline-flex h-11 items-center gap-2 border-b-2 px-3 text-callout no-underline transition-colors duration-[var(--duration-fast)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
            tab.active
              ? 'border-accent font-semibold text-text'
              : 'border-transparent text-text-secondary hover:text-text',
          );
          const children = (
            <>
              {tab.label}
              {tab.count ? (
                <span className="rounded-full bg-accent-subtle px-1.5 text-footnote tabular-nums text-text">
                  {tab.count}
                </span>
              ) : null}
            </>
          );
          return (
            <li key={tab.href}>
              {renderLink ? (
                renderLink(tab, cls, children)
              ) : (
                <a href={tab.href} className={cls} aria-current={tab.active ? 'page' : undefined}>
                  {children}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The band at the top of a module: its icon tile, its name (the page's h1) and its tab bar. */
export function ModuleHeader({
  icon,
  title,
  description,
  actions,
  tabs,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  tabs?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border bg-surface-raised">
      <div className="mx-auto flex w-full max-w-[var(--app-width)] flex-col gap-3 px-4 pt-5 md:px-8">
        <div className="flex flex-wrap items-center gap-4">
          <span
            aria-hidden
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-chrome text-on-chrome [&_svg]:h-6 [&_svg]:w-6 [&_svg]:stroke-[1.5]"
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-title-2">{title}</h1>
            {description ? <p className="text-footnote text-text-secondary">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {tabs ?? <div className="h-3" />}
      </div>
    </div>
  );
}

/** The row above a data table: search, filters and the result count on one line, wrapping on phones. */
export function TableToolbar({
  title,
  count,
  search,
  filters,
  actions,
  className,
  titleAs: Title = 'h2',
}: {
  title?: React.ReactNode;
  /** Heading level of the title, to nest under the page's headings. */
  titleAs?: 'h2' | 'h3' | 'h4';
  count?: React.ReactNode;
  search?: React.ReactNode;
  filters?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3 border-b border-border px-4 py-3', className)}>
      {title || count ? (
        <div className="flex min-w-0 items-baseline gap-2">
          {title ? <Title className="text-callout font-semibold">{title}</Title> : null}
          {count ? <span className="text-footnote text-text-secondary">{count}</span> : null}
        </div>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {search}
        {filters}
        {actions}
      </div>
    </div>
  );
}

/** A removable chip for an applied filter. */
export function FilterChip({
  label,
  onRemove,
  removeLabel,
}: {
  label: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-surface pl-3 pr-1 text-footnote">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-text-secondary hover:bg-surface-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-hidden>×</span>
      </button>
    </span>
  );
}

/** Unstyled dialog parts for full-custom overlays such as the command palette (global search). */
export const CommandDialog = {
  Root: DialogPrimitive.Root,
  Portal: DialogPrimitive.Portal,
  Overlay: DialogPrimitive.Overlay,
  Content: DialogPrimitive.Content,
  Title: DialogPrimitive.Title,
};
