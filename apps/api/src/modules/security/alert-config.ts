/**
 * Who receives Thapsus staff security alerts (ADR-0178): SECURITY_ALERT_EMAILS, a comma-separated list set
 * per cell from configuration (OpenTofu variable or Secrets Manager), never in code. Empty means alerts are
 * recorded as having no recipients and the Security overview says so.
 */
const EMAIL = /^[^\s@,<>]{1,64}@[^\s@,<>]{1,190}\.[a-z]{2,24}$/i;

export function staffAlertRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.SECURITY_ALERT_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => EMAIL.test(s));
  return [...new Set(list)].slice(0, 20);
}
