'use client';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

/** Select (DESIGN.md §6), a styled Radix select. */
export function Select({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  label,
  ...rest
}: {
  id?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  label?: string;
  'aria-describedby'?: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={label}
        aria-describedby={rest['aria-describedby']}
        className="inline-flex h-10 w-full items-center justify-between gap-2 rounded-sm border border-border-strong bg-surface-raised px-3 text-callout text-text focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown aria-hidden className="h-4 w-4 stroke-[1.5] text-text-secondary" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md bg-surface-raised p-1 text-text shadow-md"
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="relative flex h-9 cursor-default select-none items-center rounded-sm pl-8 pr-3 text-callout outline-none data-[highlighted]:bg-accent-subtle"
              >
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
