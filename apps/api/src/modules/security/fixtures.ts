import { randomUUID } from 'node:crypto';
import type { DetectionRule, FixtureEvent } from '@thapsus/core/security';
import { evaluateRules, type Db } from './engine';
import { insertSignals, type Signal } from './signals';

/**
 * Runs a rule's test fixture against the real engine (ADR-0177): the fixture's events are inserted with
 * fresh fictional ids (so nothing real can join them), the rule is evaluated, and the caller rolls the
 * transaction back. `fires` must give exactly one hit and `nearMiss` none.
 */
export function fixtureSignals(events: FixtureEvent[], now: Date, run = randomUUID().slice(0, 8)): Signal[] {
  const ids = new Map<string, string>();
  const id = (name: string) => {
    if (!ids.has(name)) ids.set(name, randomUUID());
    return ids.get(name)!;
  };
  const out: Signal[] = [];
  for (const e of events)
    for (let i = 0; i < (e.repeat ?? 1); i++)
      out.push({
        at: new Date(now.getTime() - e.minutesAgo * 60_000 + i * 1000).toISOString(),
        type: e.type,
        source: e.type.startsWith('audit.')
          ? 'audit'
          : e.type.startsWith('staffaudit.')
            ? 'staff'
            : e.type.startsWith('honeytoken.')
              ? 'honeytoken'
              : e.type.startsWith('auth.') || e.type.startsWith('staff.')
                ? 'auth'
                : 'request',
        ipKey: e.ip ? `fixture-${run}-${e.ip}` : undefined,
        ipNet: e.ip ? '192.0.2.0/24' : undefined,
        tenantId: e.tenant ? id(`tenant:${e.tenant}`) : undefined,
        actorId: e.actor ? id(`actor:${e.actor}`) : undefined,
        staffId: e.staff ? id(`staff:${e.staff}`) : undefined,
        accountKey: e.account ? `fixture-${run}-${e.account}` : undefined,
        route: e.route,
        detail: e.detail,
      });
  return out;
}

/** Inserts the events and evaluates the one rule; returns the number of hits. Run inside a transaction. */
export async function fixtureHits(db: Db, rule: DetectionRule, events: FixtureEvent[], now: Date) {
  const cursor = (
    await db.query<{ id: string }>('SELECT coalesce(max(id), 0)::text AS id FROM security.events')
  ).rows[0]!.id;
  await insertSignals(db, fixtureSignals(events, now));
  return (await evaluateRules(db, now, cursor, { rules: [rule] })).length;
}

export interface RuleTestResult {
  ruleId: string;
  version: number;
  passed: boolean;
  fires: number;
  nearMiss: number;
}

/** Tests every active rule's fixture in its own rolled-back transaction. */
export async function testRules(
  connect: () => Promise<Db & { release(): void }>,
  rules: DetectionRule[],
  now: Date,
): Promise<RuleTestResult[]> {
  const results: RuleTestResult[] = [];
  for (const rule of rules.filter((r) => r.status === 'active' && r.fixture && r.logic)) {
    const client = await connect();
    try {
      await client.query('BEGIN');
      const fires = await fixtureHits(client, rule, rule.fixture!.fires, now);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      const near = await fixtureHits(client, rule, rule.fixture!.nearMiss, now);
      await client.query('ROLLBACK');
      results.push({
        ruleId: rule.id,
        version: rule.version,
        passed: fires === 1 && near === 0,
        fires,
        nearMiss: near,
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
  return results;
}
