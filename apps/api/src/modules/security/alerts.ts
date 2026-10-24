import { t, isLocale, type Locale } from '@thapsus/core/i18n';
import { DETECTION_RULES, type Severity } from '@thapsus/core/security';
import { addDays, instantToDate } from '@thapsus/core/time';
import { TenantNotFoundError, TenantUnavailableError, withTenant } from '@thapsus/db';
import type { Deps } from '../../deps';
import { registerCellTask } from '../../jobs/registry';
import { staffAlertRecipients } from './alert-config';
import type { DetectionOutcome } from './engine';
import { onDetectionOutcomes } from './pipeline';

/**
 * Security alert emails (ADR-0178, plan §3.3), sent from the cell's own mailer in its home region:
 *  - critical and high: at once, to the staff list and to the admins of an affected workspace (customer-visible
 *    rules only);
 *  - medium: an hourly digest; low: a daily digest (staff, and each affected workspace's admins);
 *  - a daily test alert to the staff list, and a dead-man's switch when no detection run happened for 10 minutes.
 * Every alert is recorded once in security.alert_log under a dedupe key before it is sent, so several workers
 * never send it twice. Alerts carry severity, rule, region, workspace ids, counts, times and a link to the
 * incident or the Security centre, never personal data, secrets or sign-in links, and they never ask for
 * credentials.
 */
export const DEADMAN_MINUTES = 10;
const IMMEDIATE: Severity[] = ['critical', 'high'];
const STAFF_LOCALE: Locale = 'en-GB';
const ruleOf = (id: string) => DETECTION_RULES.find((r) => r.id === id);

type Audience = 'staff' | 'tenant';
type Kind = 'incident' | 'digest' | 'test' | 'deadman';

/** Claims the dedupe key; returns false when this alert was already sent (or is being sent) by anyone. */
async function claim(
  deps: Pick<Deps, 'router'>,
  key: string,
  a: { audience: Audience; kind: Kind; severity?: string; incidentId?: string; tenantId?: string },
): Promise<number | null> {
  const { rows } = await deps.router.registryPool().query<{ id: string }>(
    `INSERT INTO security.alert_log (dedupe_key, audience, kind, severity, incident_id, subject_tenant_id) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id::text`,
    [key, a.audience, a.kind, a.severity ?? null, a.incidentId ?? null, a.tenantId ?? null],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function deliver(
  deps: Pick<Deps, 'router' | 'mailer'>,
  logId: number,
  to: string[],
  subject: string,
  text: string,
) {
  let sent = 0;
  let failed = false;
  for (const address of to) {
    try {
      await deps.mailer.send({ to: address, subject, text });
      sent++;
    } catch {
      failed = true;
    }
  }
  await deps.router
    .registryPool()
    .query('UPDATE security.alert_log SET recipients = $2, status = $3 WHERE id = $1', [
      logId,
      sent,
      !to.length ? 'no_recipients' : failed && !sent ? 'failed' : 'sent',
    ]);
}

const region = (deps: Pick<Deps, 'config'>, locale: Locale) => t(locale, `regions.${deps.config.cell}`);
const footer = (locale: Locale) => t(locale, 'securityAlerts.footer');

// ---- immediate alerts ---------------------------------------------------------------------------------------
export async function sendIncidentAlerts(deps: Deps, outcomes: DetectionOutcome[]) {
  for (const o of outcomes) {
    if (!(o.newIncident || o.escalated) || !IMMEDIATE.includes(o.severity)) continue;
    const logId = await claim(deps, `incident:${o.incidentId}:${o.severity}`, {
      audience: 'staff',
      kind: 'incident',
      severity: o.severity,
      incidentId: o.incidentId,
    });
    if (logId === null) continue;
    const L = STAFF_LOCALE;
    const rule = o.hit.rule;
    const subject = t(L, 'securityAlerts.incident.subject', {
      severity: t(L, `backoffice.security.severity.${o.severity}`).toUpperCase(),
      rule: t(L, `backoffice.security.rules.${rule.id}.name`),
      region: t(L, `backoffice.metrics.regionShort.${deps.config.cell}`),
    });
    const text = [
      t(L, o.escalated ? 'securityAlerts.incident.escalated' : 'securityAlerts.incident.opened'),
      '',
      `${t(L, 'securityAlerts.field.severity')}: ${t(L, `backoffice.security.severity.${o.severity}`)}`,
      `${t(L, 'securityAlerts.field.rule')}: ${rule.id} ${t(L, `backoffice.security.rules.${rule.id}.name`)} (MITRE ATT&CK ${rule.mitre.id})`,
      `${t(L, 'securityAlerts.field.region')}: ${region(deps, L)}`,
      `${t(L, 'securityAlerts.field.workspaces')}: ${o.hit.tenantIds.length ? o.hit.tenantIds.join(', ') : t(L, 'securityAlerts.none')}`,
      `${t(L, 'securityAlerts.field.events')}: ${o.hit.count}`,
      `${t(L, 'securityAlerts.field.firstSeen')}: ${o.hit.first}`,
      `${t(L, 'securityAlerts.field.lastSeen')}: ${o.hit.last}`,
      `${t(L, 'securityAlerts.field.incident')}: ${o.incidentReference} ${deps.config.appBaseUrl}/backoffice/security/incidents/${o.incidentId}`,
      '',
      footer(L),
    ].join('\n');
    await deliver(deps, logId, staffAlertRecipients(), subject, text);
    await deps.router
      .registryPool()
      .query(`INSERT INTO security.incident_events (incident_id, kind, detail) VALUES ($1, 'alert', $2)`, [
        o.incidentId,
        JSON.stringify({ audience: 'staff', severity: o.severity }),
      ]);
  }
  // the admins of a workspace hear at once about a high or critical detection that concerns it
  for (const o of outcomes) {
    if (
      !o.isNew ||
      !o.hit.rule.customerVisible ||
      !o.hit.tenantId ||
      !IMMEDIATE.includes(o.hit.rule.severity)
    )
      continue;
    await sendTenantAlert(deps, o.hit.tenantId, `tenant:${o.detectionId}`, o.hit.rule.severity, [
      { ruleId: o.hit.rule.id, count: o.hit.count },
    ]);
  }
}

/** Emails a workspace's chosen security recipients (its owners when none are chosen), in their own language. */
export async function sendTenantAlert(
  deps: Deps,
  tenantId: string,
  key: string,
  severity: string,
  items: Array<{ ruleId: string; count: number }>,
  kind: Kind = 'incident',
) {
  const logId = await claim(deps, key, { audience: 'tenant', kind, severity, tenantId });
  if (logId === null) return;
  let found: { people: Array<{ email: string; locale: string | null }>; slug: string; fallback: Locale };
  try {
    found = await withTenant(
      deps.router,
      tenantId,
      async (tx) => {
        const tenant = await tx.one<{ slug: string; default_locale: string }>(
          'SELECT slug, default_locale FROM app.tenants',
        );
        const chosen = await tx.query<{ email: string; locale: string | null }>(
          `SELECT u.email::text, u.locale FROM app.security_alert_recipients r JOIN app.users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id WHERE u.status = 'active'`,
        );
        const owners = chosen.length
          ? chosen
          : await tx.query<{ email: string; locale: string | null }>(
              `SELECT DISTINCT u.email::text, u.locale FROM app.users u JOIN app.role_assignments ra ON ra.tenant_id = u.tenant_id AND ra.user_id = u.id
                 JOIN app.roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id WHERE u.status = 'active' AND r.key = 'owner'`,
            );
        return {
          people: owners,
          slug: tenant.slug,
          fallback: (isLocale(tenant.default_locale) ? tenant.default_locale : 'en-GB') as Locale,
        };
      },
      { readOnly: true },
    );
  } catch (err) {
    if (err instanceof TenantNotFoundError || err instanceof TenantUnavailableError) return;
    throw err;
  }
  const { people, slug, fallback } = found;
  for (const p of people) {
    const L = (isLocale(p.locale) ? p.locale : fallback) as Locale;
    const subject = t(
      L,
      kind === 'digest' ? 'securityAlerts.tenant.digestSubject' : 'securityAlerts.tenant.subject',
      {
        severity: t(L, `backoffice.security.severity.${severity}`),
        workspace: slug,
      },
    );
    const text = [
      t(L, kind === 'digest' ? 'securityAlerts.tenant.digestIntro' : 'securityAlerts.tenant.intro', {
        workspace: slug,
      }),
      '',
      ...items.map(
        (i) =>
          `- ${t(L, `backoffice.security.rules.${i.ruleId}.name`)}: ${t(L, 'securityAlerts.events', { count: i.count })}`,
      ),
      '',
      `${t(L, 'securityAlerts.tenant.open')}: ${deps.config.appBaseUrl}/app/settings/security-centre`,
      '',
      footer(L),
    ].join('\n');
    await deps.mailer.send({ to: p.email, subject, text }).catch(() => undefined);
  }
  await deps.router
    .registryPool()
    .query('UPDATE security.alert_log SET recipients = $2, status = $3 WHERE id = $1', [
      logId,
      people.length,
      people.length ? 'sent' : 'no_recipients',
    ]);
}

// ---- digests, the daily test and the dead-man's switch ------------------------------------------------------
async function digest(deps: Deps, severity: 'medium' | 'low', from: Date, to: Date, key: string) {
  const { rows } = await deps.router
    .registryPool()
    .query<{ rule_id: string; tenant: string | null; n: number; events: number }>(
      `SELECT rule_id, subject_tenant_id::text AS tenant, count(*)::int AS n, sum(event_count)::int AS events FROM security.detections
        WHERE severity = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1, 2`,
      [severity, from, to],
    );
  if (!rows.length) return;
  const logId = await claim(deps, `digest:staff:${key}`, { audience: 'staff', kind: 'digest', severity });
  if (logId !== null) {
    const L = STAFF_LOCALE;
    const byRule = new Map<string, { n: number; events: number; tenants: Set<string> }>();
    for (const r of rows) {
      const cur = byRule.get(r.rule_id) ?? { n: 0, events: 0, tenants: new Set<string>() };
      cur.n += r.n;
      cur.events += r.events;
      if (r.tenant) cur.tenants.add(r.tenant);
      byRule.set(r.rule_id, cur);
    }
    const subject = t(L, 'securityAlerts.digest.subject', {
      severity: t(L, `backoffice.security.severity.${severity}`),
      region: t(L, `backoffice.metrics.regionShort.${deps.config.cell}`),
      count: rows.reduce((s, r) => s + r.n, 0),
    });
    const text = [
      t(L, 'securityAlerts.digest.intro', {
        from: from.toISOString(),
        to: to.toISOString(),
        region: region(deps, L),
      }),
      '',
      ...[...byRule.entries()].map(
        ([rule, v]) =>
          `- ${rule} ${t(L, `backoffice.security.rules.${rule}.name`)}: ${t(L, 'securityAlerts.detections', { count: v.n })}, ${t(L, 'securityAlerts.events', { count: v.events })}, ${t(L, 'securityAlerts.workspaces', { count: v.tenants.size })}`,
      ),
      '',
      `${t(L, 'securityAlerts.field.incidents')}: ${deps.config.appBaseUrl}/backoffice/security/incidents`,
      '',
      footer(L),
    ].join('\n');
    await deliver(deps, logId, staffAlertRecipients(), subject, text);
  }
  // each affected workspace gets its own digest of the customer-visible detections about it
  const perTenant = new Map<string, Array<{ ruleId: string; count: number }>>();
  for (const r of rows)
    if (r.tenant && ruleOf(r.rule_id)?.customerVisible)
      perTenant.set(r.tenant, [...(perTenant.get(r.tenant) ?? []), { ruleId: r.rule_id, count: r.events }]);
  for (const [tenant, items] of perTenant)
    await sendTenantAlert(deps, tenant, `digest:tenant:${tenant}:${key}`, severity, items, 'digest');
}

export async function sendDigests(deps: Deps, now: Date) {
  const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const prevHour = new Date(hour.getTime() - 3_600_000);
  await digest(deps, 'medium', prevHour, hour, `medium:${prevHour.toISOString()}`);
  const today = instantToDate(now.toISOString(), 'UTC');
  const yesterday = addDays(today, -1);
  await digest(
    deps,
    'low',
    new Date(`${yesterday}T00:00:00Z`),
    new Date(`${today}T00:00:00Z`),
    `low:${yesterday}`,
  );
}

/** Once a day, so the staff list knows the alert path itself works. */
export async function sendDailyTest(deps: Deps, now: Date) {
  const day = instantToDate(now.toISOString(), 'UTC');
  const logId = await claim(deps, `test:${day}`, { audience: 'staff', kind: 'test' });
  if (logId === null) return;
  const L = STAFF_LOCALE;
  await deliver(
    deps,
    logId,
    staffAlertRecipients(),
    t(L, 'securityAlerts.test.subject', {
      region: t(L, `backoffice.metrics.regionShort.${deps.config.cell}`),
      day,
    }),
    [t(L, 'securityAlerts.test.body', { region: region(deps, L) }), '', footer(L)].join('\n'),
  );
}

/**
 * The dead-man's switch: when the detection run has not completed for 10 minutes, one alert per stall (keyed
 * by the last run time). The API checks this every minute, so a dead worker cannot silence it.
 */
export async function checkDeadman(deps: Deps, now: Date): Promise<boolean> {
  const { rows } = await deps.router
    .registryPool()
    .query<{ ran_at: string | null }>(`SELECT ran_at FROM security.pipeline_state WHERE name = 'detections'`);
  const ranAt = rows[0]?.ran_at ?? null;
  if (ranAt && now.getTime() - new Date(ranAt).getTime() < DEADMAN_MINUTES * 60_000) return false;
  // a cell that never ran detections yet (first start) is not a stall until it has been up for a while
  if (!ranAt) return false;
  const logId = await claim(deps, `deadman:${new Date(ranAt).toISOString()}`, {
    audience: 'staff',
    kind: 'deadman',
    severity: 'critical',
  });
  if (logId === null) return true;
  const L = STAFF_LOCALE;
  await deliver(
    deps,
    logId,
    staffAlertRecipients(),
    t(L, 'securityAlerts.deadman.subject', {
      region: t(L, `backoffice.metrics.regionShort.${deps.config.cell}`),
    }),
    [
      t(L, 'securityAlerts.deadman.body', {
        count: DEADMAN_MINUTES,
        at: new Date(ranAt).toISOString(),
        region: region(deps, L),
      }),
      '',
      `${t(L, 'securityAlerts.field.incidents')}: ${deps.config.appBaseUrl}/backoffice/security`,
      '',
      footer(L),
    ].join('\n'),
  );
  return true;
}

onDetectionOutcomes((deps, outcomes) => sendIncidentAlerts(deps, outcomes));
registerCellTask({
  name: 'security.alerts',
  everyMs: 60_000,
  run: async (deps, now) => {
    await sendDigests(deps, now);
    await sendDailyTest(deps, now);
  },
});
