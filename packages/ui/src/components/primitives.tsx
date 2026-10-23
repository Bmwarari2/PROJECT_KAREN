import * as React from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge our type scale and colour tokens so text-<size> and text-<colour> never collide.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'headline', 'title-1', 'title-2', 'title-3', 'body-lg', 'body', 'callout', 'footnote'] }],
      'text-color': [{ text: ['text', 'text-secondary', 'text-inverse', 'accent', 'on-accent', 'on-danger', 'success', 'warning', 'danger', 'current'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Tailwind v4's `outline-none` sets --tw-outline-style: none, which `focus-visible:outline-2` then inherits:
// combining them removed every focus ring (WCAG 2.4.7). Set the style explicitly instead.
export const focusRing = 'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

// ---- Button ---------------------------------------------------------------------------------
export const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 font-semibold select-none transition-[background-color,color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 ${focusRing}`,
  {
    variants: {
      variant: {
        primary: 'rounded-pill bg-accent text-on-accent hover:bg-accent-hover',
        secondary: 'rounded-pill bg-surface-raised text-text border border-border hover:bg-surface',
        ghost: 'rounded-md text-text hover:bg-surface',
        danger: 'rounded-pill bg-danger text-on-danger hover:opacity-90',
        link: 'text-accent underline-offset-4 hover:underline px-0',
      },
      size: {
        sm: 'h-8 whitespace-nowrap px-3 text-callout',
        md: 'h-10 whitespace-nowrap px-5 text-callout',
        // Marketing CTAs may wrap onto two lines at 320 CSS px (WCAG 1.4.10) instead of overflowing.
        lg: 'min-h-12 px-7 py-2 text-center text-body',
        icon: 'h-10 w-10 rounded-md',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, loading, children, disabled, ...props },
  ref,
) {
  const spinner = loading ? <span aria-hidden className="h-4 w-4 animate-spin rounded-pill border-2 border-current border-r-transparent" /> : null;
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    // Slot needs exactly one element child, so the spinner goes inside that child through Slottable.
    // Links have no `disabled` attribute: a disabled or loading link gets aria-disabled and leaves the tab order.
    const inert = disabled || loading;
    return (
      <Slot ref={ref} className={classes} aria-busy={loading || undefined} aria-disabled={inert || undefined} tabIndex={inert ? -1 : undefined} {...props}>
        {spinner}
        <Slottable>{children}</Slottable>
      </Slot>
    );
  }
  return (
    <button ref={ref} className={classes} aria-busy={loading || undefined} disabled={disabled || loading} {...props}>
      {spinner}
      {children}
    </button>
  );
});

// ---- Inputs ---------------------------------------------------------------------------------
const fieldBase = `w-full rounded-sm border border-border-strong bg-surface-raised px-3 text-callout text-text placeholder:text-text-secondary transition-[border-color,box-shadow] duration-[var(--duration-fast)] ${focusRing} aria-[invalid=true]:border-danger`;

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(fieldBase, 'h-10', className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, 'min-h-24 py-2', className)} {...props} />;
});

export interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => React.ReactNode;
  className?: string;
}

/** Label + control + hint/error, wired with aria-describedby. */
export function Field({ id, label, hint, error, children, className }: FieldProps) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-callout font-semibold text-text">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint ? (
        <p id={`${id}-hint`} className="text-footnote text-text-secondary">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-footnote text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---- Card / Badge / Skeleton -------------------------------------------------------------------
export function Card({ className, size = 'app', ...props }: React.HTMLAttributes<HTMLDivElement> & { size?: 'app' | 'marketing' }) {
  return <div className={cn('bg-surface-raised text-text shadow-sm', size === 'marketing' ? 'rounded-xl p-8 md:p-10' : 'rounded-lg p-5', className)} {...props} />;
}
/**
 * A card's title. Cards are usually the sections of a page, so the title is an h2 under the page's h1
 * (WCAG 1.3.1: headings do not skip levels); pass `as="h3"` for cards inside a section with its own h2.
 */
export function CardTitle({ className, as: Heading = 'h2', ...props }: React.HTMLAttributes<HTMLHeadingElement> & { as?: 'h2' | 'h3' }) {
  return <Heading className={cn('text-title-3 text-text', className)} {...props} />;
}

const badgeTone = { neutral: 'text-text-secondary', accent: 'text-accent', success: 'text-success', warning: 'text-warning', danger: 'text-danger' } as const;
export function Badge({ tone = 'neutral', className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof badgeTone }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-pill bg-surface px-2.5 py-0.5 text-footnote font-semibold', badgeTone[tone], className)} {...props} />;
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('animate-pulse rounded-sm bg-surface motion-reduce:animate-none', className)} {...props} />;
}

// ---- Empty state -----------------------------------------------------------------------------
/** `level` sets the heading element: 2 (a section of a page) by default, 1 when the empty state is the whole page. */
export function EmptyState({ icon, title, body, action, level = 2 }: { icon?: React.ReactNode; title: string; body?: string; action?: React.ReactNode; level?: 1 | 2 | 3 }) {
  const Heading = `h${level}` as const;
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-surface px-6 py-12 text-center">
      {icon ? <div className="text-text-secondary [&_svg]:h-8 [&_svg]:w-8 [&_svg]:stroke-[1.5]">{icon}</div> : null}
      <Heading className="text-title-3 text-text">{title}</Heading>
      {body ? <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{body}</p> : null}
      {action}
    </div>
  );
}

// ---- Table -----------------------------------------------------------------------------------
/**
 * `scrollLabel` names the scroll area and makes it focusable, so keyboard users can scroll a table
 * that is wider than the screen (WCAG 2.1.1); pass it wherever a table may overflow on phones.
 */
export function Table({ className, dense, scrollLabel, ...props }: React.TableHTMLAttributes<HTMLTableElement> & { dense?: boolean; scrollLabel?: string }) {
  const scroll = scrollLabel ? { tabIndex: 0, role: 'region', 'aria-label': scrollLabel } : {};
  return (
    <div className={cn('w-full overflow-x-auto rounded-lg border border-border', scrollLabel && focusRing)} {...scroll}>
      <table data-dense={dense || undefined} className={cn('w-full border-collapse text-left text-callout tabular-nums', className)} {...props} />
    </div>
  );
}
export function THead(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className="sticky top-0 z-10 bg-surface text-footnote font-semibold text-text-secondary" {...props} />;
}
export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-border last:border-b-0 hover:bg-surface/60 focus-within:bg-accent-subtle', className)} {...props} />;
}
export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn('h-11 px-4 align-middle font-semibold', className)} {...props} />;
}
export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('h-11 px-4 align-middle text-text', className)} {...props} />;
}
