'use client';
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from './primitives';

/** Dialog and sheet (DESIGN.md §6). Radix supplies focus trapping and Escape handling. */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const overlay =
  'fixed inset-0 z-40 bg-surface-inverse/40 data-[state=open]:animate-[fade-in_var(--duration-slow)_var(--ease-standard)]';

export function DialogContent({
  title,
  description,
  closeLabel,
  children,
  className,
}: {
  title: string;
  description?: string;
  closeLabel: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface-raised p-6 text-text shadow-lg outline-none data-[state=open]:animate-[dialog-in_var(--duration-slow)_var(--ease-standard)]',
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <DialogPrimitive.Title className="text-title-3">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-callout text-text-secondary">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          <DialogPrimitive.Close
            aria-label={closeLabel}
            className="rounded-md p-1 text-text-secondary hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X aria-hidden className="h-5 w-5 stroke-[1.5]" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;

export function SheetContent({
  title,
  closeLabel,
  side = 'right',
  children,
  className,
}: {
  title: string;
  closeLabel: string;
  side?: 'right' | 'left' | 'bottom';
  children: React.ReactNode;
  className?: string;
}) {
  const pos = {
    right: 'right-0 top-0 h-full w-[min(92vw,420px)]',
    left: 'left-0 top-0 h-full w-[min(86vw,320px)]',
    bottom: 'bottom-0 left-0 w-full max-h-[85vh] rounded-t-lg',
  }[side];
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 overflow-y-auto bg-surface-raised p-6 text-text shadow-lg outline-none data-[state=open]:animate-[sheet-in_var(--duration-slow)_var(--ease-standard)]',
          pos,
          className,
        )}
      >
        <div className="mb-4 flex items-center justify-between">
          <DialogPrimitive.Title className="text-title-3">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close
            aria-label={closeLabel}
            className="rounded-md p-1 text-text-secondary hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X aria-hidden className="h-5 w-5 stroke-[1.5]" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
