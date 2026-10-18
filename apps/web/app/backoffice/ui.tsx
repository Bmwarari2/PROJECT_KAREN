'use client';
import * as React from 'react';

/** Shared back-office bits. Staff sessions are separate from tenant sessions (cookie scoped to /v1/backoffice). */
export interface StaffSession {
  staffId: string;
  email: string;
  displayName: string;
  role: 'super_admin' | 'support' | 'rules_editor' | 'billing';
  cell: string;
}
export const StaffContext = React.createContext<StaffSession | null>(null);
export const useStaff = () => React.useContext(StaffContext);
export const staffCan = (s: StaffSession | null, ...roles: string[]) => !!s && (s.role === 'super_admin' || roles.includes(s.role));

export const selectClass = 'h-10 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text';

export function PageTitle({ title, lead, children }: { title: string; lead?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-title-2">{title}</h1>
        {lead ? <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">{lead}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function slaTone(flag: string): 'success' | 'warning' | 'danger' | 'neutral' {
  return flag === 'breached' ? 'danger' : flag === 'at_risk' ? 'warning' : flag === 'met' ? 'success' : 'neutral';
}
