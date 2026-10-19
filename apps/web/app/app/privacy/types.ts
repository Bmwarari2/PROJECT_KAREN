/** Shapes returned by /v1/privacy (see packages/sdk/openapi.json). */
export interface RuleRef {
  jurisdiction: string;
  key: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  packVersion: number;
  source: { url: string; title: string };
  verifiedOn: string;
}
export interface Dsr {
  id: string;
  kind: 'access' | 'correction' | 'deletion';
  status: string;
  subjectEmployeeId: string | null;
  subjectUserId: string | null;
  subjectName: string | null;
  jurisdiction: string;
  receivedOn: string;
  dueOn: string | null;
  extended: boolean;
  effectiveDueOn: string | null;
  daysRemaining: number | null;
  overdue: boolean;
  extensionAllowed: boolean;
  extensionNoticeBy: string | null;
  rule: RuleRef | null;
  identityVerifiedAt: string | null;
  identityMethod: string | null;
  identityNote: string | null;
  details: string | null;
  outcome: { export?: { generatedAt: string; summary: { tables: Record<string, number>; sensitiveValues: number; withheldCategories: string[] } }; erasure?: { erased: string[]; retained: Array<{ category: string; until: string | null; reason: string }> }; correction?: { effectiveDate: string; fields: string[] } } | null;
  exportReady: boolean;
}
export interface ErasurePlan {
  holds: Array<{ id: string; category: string | null; reason: string }>;
  erase: string[];
  retain: Array<{ category: string; until: string | null; reason: string; rules: RuleRef[] }>;
}
export const SELECT_CLASS = 'h-10 rounded-sm border border-border-strong bg-surface-raised px-2 text-callout';
