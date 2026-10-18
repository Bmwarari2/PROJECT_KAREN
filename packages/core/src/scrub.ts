/**
 * Personal-data scrubber shared by the logger and the tracer.
 * Removes values of known personal fields and redacts personal-data patterns inside free text.
 */
export const REDACTED = '[REDACTED]';

const PERSONAL_KEYS = new Set(
  [
    'name', 'firstname', 'lastname', 'givenname', 'familyname', 'fullname', 'displayname', 'preferredname',
    'middlename', 'email', 'emailaddress', 'personalemail', 'workemail', 'phone', 'phonenumber', 'mobile',
    'address', 'addressline1', 'addressline2', 'postcode', 'zipcode', 'dateofbirth', 'dob', 'birthdate',
    'ninumber', 'nationalinsurancenumber', 'ssn', 'socialsecuritynumber', 'nationalid', 'taxid', 'iban',
    'bankaccount', 'sortcode', 'password', 'passwordhash', 'secret', 'token', 'accesstoken', 'refreshtoken',
    'idtoken', 'apikey', 'authorization', 'cookie', 'setcookie', 'totp', 'otp', 'code', 'pin', 'mfasecret',
    'body', 'requestbody', 'samlresponse', 'ciphertext', 'plaintext', 'value',
  ].map((k) => k.toLowerCase()),
);

const normaliseKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isPersonalKey(key: string): boolean {
  return PERSONAL_KEYS.has(normaliseKey(key));
}

const PATTERNS: Array<[RegExp, string]> = [
  // Bearer / JWT-like tokens
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // API keys of our own format and generic long secrets
  [/\bthr_(?:live|test|sk|pk)_[A-Za-z0-9]{8,}\b/g, REDACTED],
  // Email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED],
  // UK National Insurance numbers (e.g. QQ 12 34 56 C)
  // (deliberately broader than the HMRC allocation rules so example/temporary numbers are caught too)
  [/\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi, REDACTED],
  // US SSNs
  [/\b\d{3}-\d{2}-\d{4}\b/g, REDACTED],
  // Phone numbers (international or national, 9+ digits with separators)
  [/(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{2,4}[\s-]\d{3,4}[\s-]?\d{3,4}\b/g, REDACTED],
  [/\+\d{9,15}\b/g, REDACTED],
];

export function scrubString(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function scrub<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (typeof value === 'string') return scrubString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: scrubString(value.message) } as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isPersonalKey(k) && v !== null && v !== undefined ? REDACTED : scrub(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
