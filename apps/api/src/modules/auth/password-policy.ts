import common from './common-passwords.json';

/**
 * Password policy (ASVS V6.2, ADR-0132). Length is the only composition rule:
 *  - 12 to 128 characters of any kind (spaces, symbols and Unicode allowed; no character-class rules);
 *  - not one of the 10,000 most common passwords of that length from public breach compilations
 *    (bundled offline list, compared case-insensitively; no third party is called);
 *  - not built on context-specific words: the product name, the workspace name and slug, and the
 *    person's own name and email address (docs/SECURITY.md "Context-specific words").
 * The password is otherwise used exactly as typed (no trimming, truncation or case change).
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const LEGACY = ['password1234', '123456789012', 'qwertyuiopas', 'passwordpassword', 'letmein12345'];
const COMMON = new Set<string>([...(common as { entries: string[] }).entries, ...LEGACY]);
export const COMMON_PASSWORD_COUNT = COMMON.size;

/** Product words that are never allowed inside a password, whatever the workspace. */
export const PRODUCT_WORDS = ['thapsus', 'thapsushr'];
/** Words too generic to count as context (company suffixes and common email domain labels). */
const GENERIC = new Set(['limited', 'company', 'group', 'holdings', 'gmail', 'outlook', 'hotmail', 'yahoo', 'icloud', 'example', 'mail']);
const MIN_WORD = 4;

export interface PasswordContext {
  companyName?: string | null;
  workspaceSlug?: string | null;
  email?: string | null;
  displayName?: string | null;
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const squash = (s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, '');

/** The context-specific words for a person in a workspace (each at least four letters or digits). */
export function contextWords(ctx: PasswordContext): string[] {
  const words = new Set<string>(PRODUCT_WORDS);
  const add = (text: string | null | undefined) => {
    if (!text) return;
    for (const w of fold(text).split(/[^\p{L}\p{N}]+/u)) if (w.length >= MIN_WORD && !GENERIC.has(w)) words.add(w);
  };
  add(ctx.companyName);
  add(ctx.workspaceSlug);
  if (ctx.workspaceSlug) {
    const whole = squash(ctx.workspaceSlug);
    if (whole.length >= MIN_WORD) words.add(whole);
  }
  add(ctx.displayName);
  if (ctx.email) {
    const [local, domain] = fold(ctx.email).split('@');
    add(local);
    // every domain label except the top-level one (acme.co.uk → acme)
    const labels = (domain ?? '').split('.');
    for (const label of labels.slice(0, -1)) if (label.length >= MIN_WORD && !['co', 'com', 'org', 'net'].includes(label)) add(label);
  }
  return [...words];
}

export type PasswordProblem = 'tooShort' | 'tooLong' | 'tooCommon' | 'contextSpecific';

export function passwordProblems(pw: string, ctx: PasswordContext = {}): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const length = [...pw].length;
  if (length < PASSWORD_MIN_LENGTH) problems.push('tooShort');
  if (length > PASSWORD_MAX_LENGTH) problems.push('tooLong');
  if (COMMON.has(pw.toLowerCase())) problems.push('tooCommon');
  const flat = squash(pw);
  if (contextWords(ctx).some((w) => flat.includes(squash(w)))) problems.push('contextSpecific');
  return problems;
}
