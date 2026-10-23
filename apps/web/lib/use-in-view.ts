'use client';
import * as React from 'react';

/**
 * True once the element has come within `margin` of the viewport (and stays true). Dashboard sections
 * below the fold wait for it, so a phone does not fetch and draw charts nobody has scrolled to yet.
 */
export function useInView<E extends Element>(margin = '400px'): [React.RefCallback<E>, boolean] {
  const [seen, setSeen] = React.useState(false);
  const observer = React.useRef<IntersectionObserver | null>(null);
  const ref = React.useCallback(
    (el: E | null) => {
      observer.current?.disconnect();
      if (!el || seen) return;
      if (typeof IntersectionObserver === 'undefined') return setSeen(true);
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setSeen(true);
            observer.current?.disconnect();
          }
        },
        { rootMargin: margin },
      );
      observer.current.observe(el);
    },
    [margin, seen],
  );
  return [ref, seen];
}
