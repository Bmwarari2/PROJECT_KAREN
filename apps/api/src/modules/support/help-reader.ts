import { canSome, type Principal } from '@thapsus/core/permissions';
import { helpReader, type HelpReader } from '@thapsus/core/help';
import { loadFeatureFlags, type Tx } from '@thapsus/db';
import { aiConfig } from '../ai/flags';

/**
 * Who is reading help (ADR-0190): the caller's permissions, the workspace's feature flags, whether Ask HR
 * is on for the workspace (entitled and switched on by the customer), whether it is a sandbox, and the
 * countries of its legal entities. The help centre, help search, the in-page help links and Ask HR's
 * suggested articles all filter with this one reader. Nothing here is personal data.
 */
export async function helpReaderFor(tx: Tx, principal: Principal): Promise<HelpReader> {
  const features = await loadFeatureFlags(tx);
  const tenant = await tx.one<{ kind: string }>('SELECT kind FROM app.tenants');
  const countries = (
    await tx.query<{ country: string }>('SELECT DISTINCT country FROM app.legal_entities ORDER BY country')
  ).map((r) => r.country.trim().toUpperCase());
  const has = (p: string) => canSome(principal, p);
  const askHr = features.aiAssistant && (await aiConfig(tx)).enabled && has('ai.ask');
  return helpReader(
    { has, employeeId: principal.employeeId ?? null, features, askHr, sandbox: tenant.kind === 'sandbox' },
    countries,
  );
}
