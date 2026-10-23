'use client';
import * as React from 'react';

/**
 * Windowing for long lists with a fixed row height: only rows in (or near) the viewport are
 * rendered, so a 10,000-row rota stays responsive on low-cost phones. Scroll handling is passive
 * and coalesced to one update per animation frame.
 */
export function useVirtualRows(opts: {
  count: number;
  rowHeight: number;
  overscan?: number;
  scrollRef: React.RefObject<HTMLElement | null>;
  headerHeight?: number;
}) {
  const { count, rowHeight, overscan = 8, scrollRef, headerHeight = 0 } = opts;
  const [range, setRange] = React.useState({ start: 0, end: Math.min(count, 40) });
  const compute = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = Math.max(0, el.scrollTop - headerHeight);
    const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
    const visible = Math.ceil((el.clientHeight || rowHeight * 20) / rowHeight);
    const end = Math.min(count, start + visible + overscan * 2);
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [count, rowHeight, overscan, scrollRef, headerHeight]);

  React.useLayoutEffect(() => {
    compute();
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        compute();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => compute()) : undefined;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [compute, scrollRef]);

  return { ...range, totalHeight: count * rowHeight };
}
