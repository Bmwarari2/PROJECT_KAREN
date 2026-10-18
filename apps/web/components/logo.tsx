/** Thapsus-HR mark: a simple stem with three leaves (original artwork). */
export function Logo({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-[-0.01em] text-text ${className ?? ''}`}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-accent">
        <path d="M12 21V6" />
        <path d="M12 9c-3.5 0-5-2.5-5-5 3 0 5 1.8 5 5Z" />
        <path d="M12 13c3.5 0 5-2.5 5-5-3 0-5 1.8-5 5Z" />
        <path d="M12 17c-3.5 0-5-2.5-5-5 3 0 5 1.8 5 5Z" />
      </svg>
      <span>{label}</span>
    </span>
  );
}
