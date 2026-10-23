'use client';
import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from './primitives';

/** In-page tabs (DESIGN.md §6), Radix tabs. */
export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex flex-wrap gap-x-6 border-b border-border', className)}
      {...props}
    />
  );
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
