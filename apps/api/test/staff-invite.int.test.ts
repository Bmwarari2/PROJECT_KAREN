import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '@thapsus/db';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { addSecretVersion, parseInvitee, staffInvite } from '../src/cli/staging/staff-invite';

/**
 * The staging staff-invite job (ADR-0174): the first staff member gets a one-time passkey enrolment link
 * in Secret Manager, never in a log; once the back office has staff, the automatic run does nothing.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('staging staff invite job', () => {
  it('validates the invitee from the repository variables and skips when none is configured', async () => {
    expect(parseInvitee(undefined)).toBeUndefined();
    expect(parseInvitee(JSON.stringify({ email: '', name: '' }))).toBeUndefined();
    expect(() => parseInvitee(JSON.stringify({ email: 'not-an-email', name: 'X' }))).toThrow();
    expect(() =>
      parseInvitee(JSON.stringify({ email: 'a@example.test', name: 'X', role: 'root' })),
    ).toThrow();
    expect(
      parseInvitee(JSON.stringify({ email: 'founder@thapsus.example.test', name: 'Fictional Founder' })),
    ).toEqual({
      email: 'founder@thapsus.example.test',
      name: 'Fictional Founder',
      role: 'super_admin',
    });
    const written: string[] = [];
    expect(
      await staffInvite({
        deps: ctx.deps,
        invitee: undefined,
        mode: 'first',
        write: async (p) => void written.push(p),
      }),
    ).toEqual({ done: 'skipped', reason: 'notConfigured' });
    expect(written).toEqual([]);
    await expect(
      staffInvite({
        deps: { ...ctx.deps, config: { ...ctx.deps.config, env: 'prod' } },
        invitee: parseInvitee(JSON.stringify({ email: 'x@thapsus.example.test', name: 'X' })),
        mode: 'reissue',
        write: async () => undefined,
      }),
    ).rejects.toThrow(/staging only/);
  });

  it('creates the account once, writes only the link to the secret, and reissues on request', async () => {
    const pool = getPool(ctx.deps.backofficeDbUrl!);
    const email = `founder.${Math.random().toString(36).slice(2, 7)}@thapsus.example.test`;
    const invitee = parseInvitee(JSON.stringify({ email, name: 'Fictional Founder', role: 'super_admin' }));
    const written: string[] = [];
    const write = async (p: string) => void written.push(p);
    // the automatic run creates the first account, then never again (other suites may have made staff)
    const before = (
      await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM backoffice.staff_users WHERE active')
    ).rows[0]!.n;
    const first =
      before === 0
        ? await staffInvite({ deps: ctx.deps, invitee, mode: 'first', write })
        : await staffInvite({ deps: ctx.deps, invitee, mode: 'reissue', write });
    expect(first).toMatchObject({ done: 'invited', created: true });
    expect(await staffInvite({ deps: ctx.deps, invitee, mode: 'first', write })).toEqual({
      done: 'skipped',
      reason: 'staffExists',
    });
    const payload = JSON.parse(written.at(-1)!);
    expect(payload.enrolmentUrl).toMatch(
      /^http:\/\/localhost:3000\/backoffice\/enrol#token=[A-Za-z0-9_-]{40,}$/,
    );
    expect(payload).toMatchObject({ role: 'super_admin' });
    expect(written.at(-1)).not.toContain(email);
    const again = await staffInvite({ deps: ctx.deps, invitee, mode: 'reissue', write });
    expect(again).toMatchObject({ done: 'invited', created: false });
    // only the newest link works
    const tokens = written.map((w) => /token=([^"]+)/.exec(JSON.parse(w).enrolmentUrl)![1]!);
    const options = (token: string) =>
      ctx.app.inject({ method: 'POST', url: '/v1/backoffice/auth/enrol/options', payload: { token } });
    expect((await options(tokens.at(-2)!)).statusCode).toBe(401);
    expect((await options(tokens.at(-1)!)).statusCode).toBe(200);
    const accounts = await pool.query('SELECT role FROM backoffice.staff_users WHERE email = $1', [email]);
    expect(accounts.rows).toEqual([{ role: 'super_admin' }]);
  });

  it('writes the secret version with the job identity, never with the link in the URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url.includes('metadata.google.internal')
        ? new Response(JSON.stringify({ access_token: 'fictional-token' }))
        : new Response('{}');
    }) as typeof fetch;
    await addSecretVersion(
      fake,
      'projects/thapsus-test/secrets/thapsus-stg-uk-staff-invite',
      '{"enrolmentUrl":"x"}',
    );
    expect(calls[0]!.url).toContain('/computeMetadata/v1/instance/service-accounts/default/token');
    expect(calls[1]!.url).toBe(
      'https://secretmanager.googleapis.com/v1/projects/thapsus-test/secrets/thapsus-stg-uk-staff-invite:addVersion',
    );
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({
      payload: { data: Buffer.from('{"enrolmentUrl":"x"}').toString('base64') },
    });
    await expect(addSecretVersion(fake, 'projects/x/secrets/../other', 'x')).rejects.toThrow();
  });
});
