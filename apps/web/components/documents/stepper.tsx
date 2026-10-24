'use client';
import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@thapsus/ui';

/**
 * A short horizontal stepper for a task done in a few steps (review, confirm, sign, done). The idea follows
 * EasyUI's `stepper` (MIT, © 2026 Suraj Maurya; reference only, rebuilt from our tokens without its motion
 * library). Steps are an ordered list; the current one has aria-current="step" and done ones show a tick.
 */
export function Stepper({ steps, current, label }: { steps: string[]; current: number; label: string }) {
  return (
    <ol aria-label={label} className="flex items-start gap-1">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li
            key={s}
            aria-current={active ? 'step' : undefined}
            className="flex min-w-0 flex-1 flex-col items-center gap-1 text-center"
          >
            <span className="flex w-full items-center">
              <span
                aria-hidden
                className={cn(
                  'h-px flex-1',
                  i === 0 ? 'bg-transparent' : done || active ? 'bg-accent' : 'bg-border',
                )}
              />
              <span
                aria-hidden
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-footnote font-semibold transition-colors duration-[var(--duration-fast)] motion-reduce:transition-none',
                  done && 'bg-accent text-on-accent',
                  active && 'border-2 border-accent bg-surface-raised text-accent',
                  !done && !active && 'border border-border-strong text-text-secondary',
                )}
              >
                {done ? <Check className="h-4 w-4 stroke-[2]" /> : i + 1}
              </span>
              <span
                aria-hidden
                className={cn(
                  'h-px flex-1',
                  i === steps.length - 1 ? 'bg-transparent' : done ? 'bg-accent' : 'bg-border',
                )}
              />
            </span>
            <span
              className={cn(
                'w-full break-words text-footnote',
                active ? 'font-semibold text-text' : 'text-text-secondary',
              )}
            >
              {s}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
