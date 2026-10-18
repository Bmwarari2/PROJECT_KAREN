import generated from './generated.json' with { type: 'json' };
import legal from './legal.json' with { type: 'json' };
import type { HomeRegion } from '../regions';

/**
 * Trust and legal data shared by the API (DPA acceptance, sub-processor notices, privacy notice
 * templates) and the public trust pages. Generated from docs/SUBPROCESSORS.md and docs/legal/*.md
 * (scripts/trust-data.ts); legal.json holds contractual settings pending legal review.
 */
export type LegalTemplate = 'uk' | 'eu' | 'us';
export const LEGAL_TEMPLATES: readonly LegalTemplate[] = ['uk', 'eu', 'us'];

export interface SubprocessorChange {
  id: string;
  type: 'baseline' | 'addition' | 'replacement' | 'removal' | 'change';
  announced: string;
  effectiveFrom: string;
  regions: string[];
  change: string;
}

export interface TrustData {
  subprocessors: { sections: Array<{ title: string; columns: string[]; rows: string[][] }>; changes: SubprocessorChange[] };
  notices: Record<LegalTemplate, { title: string; version: string; body: string; sha256: string }>;
  dpa: Record<LegalTemplate, { version: string; sha256: string; path: string }>;
}

export const TRUST: TrustData = generated as TrustData;

export interface LegalSettings {
  legalReview: 'pending' | 'reviewed';
  subprocessorNoticeDays: number;
  processorBreachNotifyHours: number;
  closureGraceDays: number;
  dsrReminderDaysBefore: number[];
  incidentReminderHoursBefore: number[];
  backupRetentionDays: Record<'dev' | 'test' | 'staging' | 'prod', number>;
  logRetentionDays: Record<'dev' | 'test' | 'staging' | 'prod', number>;
  securityContactLocalPart: string;
  privacyContactLocalPart: string;
}

export const LEGAL: LegalSettings = legal as LegalSettings;

/** The DPA template and privacy-notice template that apply to a home region. */
export const templateForRegion = (region: HomeRegion): LegalTemplate => region;
