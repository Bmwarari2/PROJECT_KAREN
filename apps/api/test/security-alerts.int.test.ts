import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, writeAudit } from '@thapsus/db';
import { checkDeadman, sendDailyTest, sendDigests } from '../src/modules/security/alerts';
import { runDetectionPipeline } from '../src/modules/security/pipeline';
import { insertSignals } from '../src/modules/security/signals';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';

/**
 * Security alert emails (ADR-0178, plan §3.3): critical and high at once, medium hourly and low daily digests,
 * the daily test and the dead-man's switch, each sent once, to the configured staff list and to the affected
 * workspace's admins, with no personal data, secrets or sign-in links.
 */
const STAFF = ['security@thapsus.example.test', 'founder@thapsus.example.test'];
const DECOY = 'thr_sk_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e.decoyKeyDoNotUseXq7Lm2Np9Rs4Tv6Wy8Za0Bc3Df5Gh';
let ctx: TestContext;
let ip = 40;
const later = (ms = 15_000) => new Date(ctx.clock.now.getTime() + ms);
async function detect(at = later()) {
  await ctx.app.securitySignals!.flush();
  return runDetectionPipeline(ctx.deps, at);
}
const mailTo = (to: string) => ctx.mailer.sent.filter((m) => m.to === to);

beforeAll(async () => {
  process.env.SECURITY_ALERT_EMAILS = STAFF.join(', ');
  ctx = await startTestApp({ listen: false });
  await detect();
});
beforeEach(() => {
  ctx.mailer.sent.length = 0;
});
afterAll(async () => {
  delete process.env.SECURITY_ALERT_EMAILS;
  await ctx.close();
  await closeDb();
});

describe('immediate alerts', () => {
  it('a critical incident emails the staff list once, with the incident link and no personal data', async () => {
    const address = `203.0.113.${ip++}`;
    await ctx.app.inject({
      method: 'GET',
      url: '/v1/employees',
      headers: { authorization: `Bearer ${DECOY}` },
      remoteAddress: address,
    });
    const run = await detect();
    const o = run.outcomes.find((x) => x.hit.rule.id === 'THR-DECEPT-001' && x.newIncident)!;
    for (const to of STAFF) {
      const [mail] = mailTo(to);
      expect(mail!.subject).toBe('[Thapsus-HR security] CRITICAL: Decoy key or object used (UK)');
      expect(mail!.text).toContain(
        `${o.incidentReference} http://localhost:3000/backoffice/security/incidents/${o.incidentId}`,
      );
      expect(mail!.text).toContain('THR-DECEPT-001');
      expect(mail!.text).toContain('United Kingdom (London)');
      expect(mail!.text).not.toContain(address);
      expect(mail!.text).not.toContain(o.hit.ipKey!);
      expect(mail!.text).not.toMatch(/decoyKey|thr_sk_|signin|magic|token=/i);
    }
    ctx.mailer.sent.length = 0;
    await detect(later(30_000));
    expect(ctx.mailer.sent.filter((m) => m.subject.includes('Decoy key'))).toEqual([]);
  });

  it('a high detection about a workspace also emails its owners, pointing to their Security centre', async () => {
    const owner = await ownerSession(ctx);
    const user = (
      await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
        tx.one<{ id: string }>('SELECT id FROM app.users LIMIT 1'),
      )
    ).id;
    await insertSignals(ctx.deps.router.registryPool(), [
      ...Array.from({ length: 5 }, (_, i) => ({
        at: new Date(ctx.clock.now.getTime() - 5 * 60_000 + i * 1000).toISOString(),
        type: 'audit.auth.login_failed',
        source: 'audit' as const,
        tenantId: owner.tenantId,
        actorId: user,
      })),
      {
        at: ctx.clock.now.toISOString(),
        type: 'audit.auth.login',
        source: 'audit',
        tenantId: owner.tenantId,
        actorId: user,
      },
    ]);
    await detect();
    const [mail] = mailTo(owner.email);
    expect(mail!.subject).toBe(`Security alert for ${owner.slug}: High`);
    expect(mail!.text).toContain('Sign-in after many failures');
    expect(mail!.text).toContain('http://localhost:3000/app/settings/security-centre');
    expect(mail!.text).not.toMatch(/Olive|@/);
  });
});

describe('digests, the daily test and the dead-man switch', () => {
  it('medium detections arrive in one hourly digest, for staff and for the workspace', async () => {
    const owner = await ownerSession(ctx);
    const at = new Date(Math.floor(ctx.clock.now.getTime() / 3_600_000) * 3_600_000 + 60_000);
    await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      writeAudit(tx, {
        actorType: 'user',
        actorId: owner.userId,
        action: 'role.assigned',
        targetType: 'user',
        targetId: owner.userId,
        diff: { isAdmin: { from: null, to: true } },
      }),
    );
    await detect(new Date(Math.max(at.getTime(), Date.now() + 15_000)));
    ctx.mailer.sent.length = 0;
    const nextHour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000 + 60_000);
    await sendDigests(ctx.deps, nextHour);
    const staff = mailTo(STAFF[0]!).find((m) => /Detections digest: Medium/.test(m.subject))!;
    expect(staff.text).toContain('THR-PRIV-001 Admin role granted');
    const tenant = mailTo(owner.email).find((m) => m.subject === `Security alerts for ${owner.slug}`)!;
    expect(tenant.text).toContain('Admin role granted');
    ctx.mailer.sent.length = 0;
    await sendDigests(ctx.deps, new Date(nextHour.getTime() + 60_000));
    expect(ctx.mailer.sent.filter((m) => /digest|Security alerts for/.test(m.subject))).toEqual([]);
  });

  it('sends one test alert a day', async () => {
    const day = new Date('2031-03-04T09:00:00Z');
    await sendDailyTest(ctx.deps, day);
    await sendDailyTest(ctx.deps, new Date('2031-03-04T18:00:00Z'));
    expect(mailTo(STAFF[1]!).map((m) => m.subject)).toEqual([
      '[Thapsus-HR security] Daily test alert (UK, 2031-03-04)',
    ]);
  });

  it('alerts once when no detection run completed for ten minutes', async () => {
    const pool = ctx.deps.router.registryPool();
    const ranAt = new Date(Date.now() - 11 * 60_000);
    await pool.query(`UPDATE security.pipeline_state SET ran_at = $1 WHERE name = 'detections'`, [ranAt]);
    expect(await checkDeadman(ctx.deps, new Date())).toBe(true);
    expect(await checkDeadman(ctx.deps, new Date(Date.now() + 60_000))).toBe(true);
    const sent = mailTo(STAFF[0]!).filter((m) => /detections stopped/.test(m.subject));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(ranAt.toISOString());
    await pool.query(`UPDATE security.pipeline_state SET ran_at = $1 WHERE name = 'detections'`, [
      new Date(),
    ]);
    expect(await checkDeadman(ctx.deps, new Date())).toBe(false);
  });

  it('records an alert without recipients when no staff list is configured', async () => {
    const saved = process.env.SECURITY_ALERT_EMAILS;
    delete process.env.SECURITY_ALERT_EMAILS;
    try {
      await sendDailyTest(ctx.deps, new Date('2031-03-05T09:00:00Z'));
      const { rows } = await ctx.deps.router
        .registryPool()
        .query(`SELECT status, recipients FROM security.alert_log WHERE dedupe_key = 'test:2031-03-05'`);
      expect(rows).toEqual([{ status: 'no_recipients', recipients: 0 }]);
    } finally {
      process.env.SECURITY_ALERT_EMAILS = saved;
    }
  });
});
