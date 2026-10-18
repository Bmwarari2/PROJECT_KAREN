import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const focusRing = 'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

// ---- Button ---------------------------------------------------------------------------------
export const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold select-none transition-[background-color,color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${focusRing}`,
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
        sm: 'h-8 px-3 text-callout',
        md: 'h-10 px-5 text-callout',
        lg: 'h-12 px-7 text-body',
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
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} aria-busy={loading || undefined} disabled={disabled || loading} {...props}>
      {loading ? <span aria-hidden className="h-4 w-4 animate-spin rounded-pill border-2 border-current border-r-transparent" /> : null}
      {children}
    </Comp>
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
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-title-3 text-text', className)} {...props} />;
}

const badgeTone = { neutral: 'text-text-secondary', accent: 'text-accent', success: 'text-success', warning: 'text-warning', danger: 'text-danger' } as const;
export function Badge({ tone = 'neutral', className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof badgeTone }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-pill bg-surface px-2.5 py-0.5 text-footnote font-semibold', badgeTone[tone], className)} {...props} />;
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('animate-pulse rounded-sm bg-surface motion-reduce:animate-none', className)} {...props} />;
}

// ---- Empty state -----------------------------------------------------------------------------
export function EmptyState({ icon, title, body, action }: { icon?: React.ReactNode; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-surface px-6 py-12 text-center">
      {icon ? <div className="text-text-secondary [&_svg]:h-8 [&_svg]:w-8 [&_svg]:stroke-[1.5]">{icon}</div> : null}
      <h3 className="text-title-3 text-text">{title}</h3>
      {body ? <p className="max-w-[var(--prose-width)] text-callout text-text-secondary">{body}</p> : null}
      {action}
    </div>
  );
}

// ---- Table -----------------------------------------------------------------------------------
export function Table({ className, dense, ...props }: React.TableHTMLAttributes<HTMLTableElement> & { dense?: boolean }) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-border">
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
