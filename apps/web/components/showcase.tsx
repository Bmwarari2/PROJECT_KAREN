'use client';
import * as React from 'react';
import { cn } from '@thapsus/ui';

/**
 * Sticky feature showcase: text panels scroll normally while a sticky visual swaps to the panel in view.
 * Uses IntersectionObserver only (no scroll handlers); fully static under reduced motion.
 */
export function FeatureShowcase({ features }: { features: Array<{ key: string; title: string; body: string; icon: React.ReactNode }> }) {
  const [active, setActive] = React.useState(0);
  const refs = React.useRef<Array<HTMLLIElement | null>>([]);
  React.useEffect(() => {
    // Reduced motion: a static showcase (first panel active), no scroll-driven changes.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.index));
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  return (
    <div className="mt-12 grid gap-10 md:grid-cols-2">
      <ol className="flex flex-col gap-6 md:gap-[30vh] md:py-[10vh]">
        {features.map((f, i) => (
          <li
            key={f.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            data-index={i}
            className={cn(
              'rounded-xl bg-surface-raised p-8 transition-[border-color] duration-[var(--duration-base)] md:rounded-none md:border-l-2 md:bg-transparent md:py-0 md:pl-6 md:pr-0',
              active === i ? 'md:border-accent' : 'md:border-border',
            )}
          >
            <div className="text-accent [&_svg]:h-7 [&_svg]:w-7 [&_svg]:stroke-[1.5]">{f.icon}</div>
            <h3 className="mt-4 text-title-2">{f.title}</h3>
            <p className="mt-2 text-body text-text-secondary">{f.body}</p>
          </li>
        ))}
      </ol>
      <div aria-hidden className="hidden md:block">
        <div className="sticky top-[calc(var(--nav-height)+10vh)] flex aspect-[4/5] items-center justify-center rounded-xl bg-surface-raised shadow-md">
          {features.map((f, i) => (
            <div
              key={f.key}
              className={cn(
                'absolute flex flex-col items-center gap-4 text-accent transition-[opacity,transform] duration-[var(--duration-slow)] ease-[var(--ease-standard)] [&_svg]:h-24 [&_svg]:w-24 [&_svg]:stroke-[1]',
                active === i ? 'opacity-100' : 'translate-y-4 opacity-0',
              )}
            >
              {f.icon}
              <span className="text-title-3 text-text">{f.title}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
