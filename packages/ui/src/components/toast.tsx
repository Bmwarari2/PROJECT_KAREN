'use client';
import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { X } from 'lucide-react';
import { cn } from './primitives';

/** Toasts (DESIGN.md §6): the provider in the root layout and useToast(). */
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
  const push = React.useCallback(
    (t: Omit<ToastItem, 'id'>) => setItems((xs) => [...xs, { ...t, id: Date.now() + Math.random() }]),
    [],
  );
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
              <ToastPrimitive.Title
                className={cn(
                  'text-callout font-semibold',
                  t.tone === 'danger' && 'text-danger',
                  t.tone === 'success' && 'text-success',
                )}
              >
                {t.title}
              </ToastPrimitive.Title>
              {t.body ? (
                <ToastPrimitive.Description className="text-footnote text-text-secondary">
                  {t.body}
                </ToastPrimitive.Description>
              ) : null}
            </div>
            <ToastPrimitive.Close
              aria-label={closeLabel}
              className="rounded-md p-1 text-text-secondary hover:bg-surface"
            >
              <X aria-hidden className="h-4 w-4 stroke-[1.5]" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,380px)] -translate-x-1/2 flex-col gap-2 outline-none md:left-auto md:right-6 md:translate-x-0" />
      </ToastPrimitive.Provider>
    </ToastCtx.Provider>
  );
}
