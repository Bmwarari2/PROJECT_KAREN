import * as React from 'react';
import { cn } from '@thapsus/ui';

export interface DetailItem {
  key: string;
  label: string;
  value: React.ReactNode;
}

/** The facts of a record on its detail page (ADR-0161): label and value pairs in a responsive grid. */
export function DetailList({ items, className }: { items: DetailItem[]; className?: string }) {
  if (!items.length) return null;
  return (
    <dl className={cn('grid gap-x-6 gap-y-3 text-callout sm:grid-cols-2', className)}>
      {items.map((i) => (
        <div key={i.key} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-footnote text-text-secondary">{i.label}</dt>
          <dd className="break-words text-text">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
