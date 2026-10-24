'use client';
import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from './primitives';
import { openedOnce, standInTrigger, useOverlayOpened } from './overlay';

/** Popovers (DESIGN.md §6). */
export const Popover = openedOnce(PopoverPrimitive.Root, 'Popover');
export const PopoverTrigger = standInTrigger(PopoverPrimitive.Trigger, 'dialog', 'PopoverTrigger');
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // the content mounts once the popover is first opened (ADR-0186)
  if (!useOverlayOpened()) return null;
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
