'use client';
import * as React from 'react';

/**
 * True once the browser has been idle after the first render (or `timeout` ms have passed). Below-the-
 * fold dashboard widgets wait for it, so the page's first content and its own data come first.
 */
export function useIdle(timeout = 1500): boolean {
  const [idle, setIdle] = React.useState(false);
  React.useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setIdle(true), { timeout });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setIdle(true), 200);
    return () => window.clearTimeout(id);
  }, [timeout]);
  return idle;
}
