'use client';
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from './primitives';

// ---- Dialog & Sheet --------------------------------------------------------------------------
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const overlay = 'fixed inset-0 z-40 bg-surface-inverse/40 data-[state=open]:animate-[fade-in_var(--duration-slow)_var(--ease-standard)]';

export function DialogContent({ title, description, closeLabel, children, className }: { title: string; description?: string; closeLabel: string; children: React.ReactNode; className?: string }) {
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
            {description ? <DialogPrimitive.Description className="mt-1 text-callout text-text-secondary">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close aria-label={closeLabel} className="rounded-md p-1 text-text-secondary hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent">
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

export function SheetContent({ title, closeLabel, side = 'right', children, className }: { title: string; closeLabel: string; side?: 'right' | 'left' | 'bottom'; children: React.ReactNode; className?: string }) {
  const pos = { right: 'right-0 top-0 h-full w-[min(92vw,420px)]', left: 'left-0 top-0 h-full w-[min(86vw,320px)]', bottom: 'bottom-0 left-0 w-full max-h-[85vh] rounded-t-lg' }[side];
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <DialogPrimitive.Content className={cn('fixed z-50 overflow-y-auto bg-surface-raised p-6 text-text shadow-lg outline-none data-[state=open]:animate-[sheet-in_var(--duration-slow)_var(--ease-standard)]', pos, className)}>
        <div className="mb-4 flex items-center justify-between">
          <DialogPrimitive.Title className="text-title-3">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close aria-label={closeLabel} className="rounded-md p-1 text-text-secondary hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent">
            <X aria-hidden className="h-5 w-5 stroke-[1.5]" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// ---- Select ----------------------------------------------------------------------------------
export function Select({ id, value, onValueChange, options, placeholder, label, ...rest }: { id?: string; value?: string; onValueChange?: (v: string) => void; options: Array<{ value: string; label: string }>; placeholder?: string; label?: string; 'aria-describedby'?: string }) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={label}
        aria-describedby={rest['aria-describedby']}
        className="inline-flex h-10 w-full items-center justify-between gap-2 rounded-sm border border-border-strong bg-surface-raised px-3 text-callout text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown aria-hidden className="h-4 w-4 stroke-[1.5] text-text-secondary" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md bg-surface-raised p-1 text-text shadow-md">
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={o.value} className="relative flex h-9 cursor-default select-none items-center rounded-sm pl-8 pr-3 text-callout outline-none data-[highlighted]:bg-accent-subtle">
                <SelectPrimitive.ItemIndicator className="absolute left-2">
                  <Check aria-hidden className="h-4 w-4 stroke-[1.5] text-accent" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// ---- Tabs ------------------------------------------------------------------------------------
export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex gap-6 border-b border-border', className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        '-mb-px h-10 border-b-2 border-transparent text-callout font-semibold text-text-secondary transition-colors duration-[var(--duration-base)] hover:text-text data-[state=active]:border-accent data-[state=active]:text-text focus-visible:outline-2 focus-visible:outline-accent',
        className,
      )}
      {...props}
    />
  );
}
export const TabsContent = TabsPrimitive.Content;

// ---- Toast -----------------------------------------------------------------------------------
interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone?: 'neutral' | 'success' | 'danger';
}
const ToastCtx = React.createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);
export const useToast = () => React.useContext(ToastCtx);

export function ToastProvider({ children, closeLabel }: { children: React.ReactNode; closeLabel: string }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const push = React.useCallback((t: Omit<ToastItem, 'id'>) => setItems((xs) => [...xs, { ...t, id: Date.now() + Math.random() }]), []);
  return (
    <ToastCtx.Provider value={push}>
      <ToastPrimitive.Provider duration={5000} swipeDirection="right">
        {children}
        {items.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            onOpenChange={(open) => !open && setItems((xs) => xs.filter((x) => x.id !== t.id))}
            className="flex items-start gap-3 rounded-md bg-surface-raised p-4 text-text shadow-lg data-[state=open]:animate-[toast-in_var(--duration-base)_var(--ease-standard)]"
          >
            <div className="flex-1">
              <ToastPrimitive.Title className={cn('text-callout font-semibold', t.tone === 'danger' && 'text-danger', t.tone === 'success' && 'text-success')}>{t.title}</ToastPrimitive.Title>
              {t.body ? <ToastPrimitive.Description className="text-footnote text-text-secondary">{t.body}</ToastPrimitive.Description> : null}
            </div>
            <ToastPrimitive.Close aria-label={closeLabel} className="rounded-md p-1 text-text-secondary hover:bg-surface">
              <X aria-hidden className="h-4 w-4 stroke-[1.5]" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,380px)] -translate-x-1/2 flex-col gap-2 outline-none md:left-auto md:right-6 md:translate-x-0" />
      </ToastPrimitive.Provider>
    </ToastCtx.Provider>
  );
}
