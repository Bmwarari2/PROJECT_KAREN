'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * A link that prefetches its route when the user shows intent (pointer over it, focus, touch) instead
 * of as soon as it scrolls into view. The rail, tab bars and dashboards hold dozens of links; prefetching
 * them all during load competed with the page's own data on slow phones (docs/PERFORMANCE.md).
 */
export function IntentLink({
  href,
  onMouseEnter,
  onFocus,
  onTouchStart,
  ...rest
}: React.ComponentProps<typeof Link>) {
  const router = useRouter();
  const prefetch = () => {
    if (typeof href === 'string') router.prefetch(href);
  };
  return (
    <Link
      href={href}
      prefetch={false}
      onMouseEnter={(e) => {
        prefetch();
        onMouseEnter?.(e);
      }}
      onFocus={(e) => {
        prefetch();
        onFocus?.(e);
      }}
      onTouchStart={(e) => {
        prefetch();
        onTouchStart?.(e);
      }}
      {...rest}
    />
  );
}
