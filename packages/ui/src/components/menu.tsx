import * as React from 'react';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from './primitives';

/** Menus (DESIGN.md §6): Radix dropdown menu with token styling. */
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
