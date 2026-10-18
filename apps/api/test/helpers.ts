import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import type { HomeRegion } from '@thapsus/core';
import { closeAllPools } from '@thapsus/db';
import { appUrl, testRouter, TEST_DBS } from '@thapsus/db/testing';
import { buildApp } from '../src/app';
import type { Deps } from '../src/deps';
import { InMemoryDirectory } from '../src/lib/directory';
import { LocalKeyProvider } from '../src/lib/kms';
import { MemoryMailer } from '../src/lib/mailer';
import { MemoryRateLimiter } from '../src/lib/rate-limit';
import { MemoryObjectStore } from '../src/lib/object-store';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export interface TestContext {
  app: FastifyInstance;
  deps: Deps;
  mailer: MemoryMailer;
  directory: InMemoryDirectory;
  dnsRecords: Map<string, string[][]>;
  clock: { now: Date; advanceMinutes(n: number): void };
  base: string;
  close(): Promise<void>;
}

export async function startTestApp(opts: { cell?: HomeRegion; directory?: InMemoryDirectory; listen?: boolean; overrides?: Partial<Deps> } = {}): Promise<TestContext> {
  const cell = opts.cell ?? 'uk';
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const mailer = new MemoryMailer(cell);
  const directory = opts.directory ?? new InMemoryDirectory();
  const dnsRecords = new Map<string, string[][]>();
  const clock = {
    now: new Date(),
    advanceMinutes(n: number) {
      this.now = new Date(this.now.getTime() + n * 60_000);
    },
  };
  const deps: Deps = {
    config: { env: 'test', cell, domain: 'thapsus-hr.test', appBaseUrl: 'http://localhost:3000', apiBaseUrl: base, globalBaseUrl: 'http://localhost:3000' },
    router: testRouter(cell),
    directory,
    mailer,
    keys: new LocalKeyProvider('11'.repeat(32)),
    limiter: new MemoryRateLimiter(),
    dns: { resolveTxt: async (name: string) => dnsRecords.get(name) ?? Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })) },
    objects: new MemoryObjectStore(),
    now: () => clock.now,
    regionalAppUrls: { uk: 'https://app.uk.thapsus-hr.test', eu: 'https://app.eu.thapsus-hr.test', us: 'https://app.us.thapsus-hr.test' },
    regionalApiUrls: { uk: base, eu: base, us: base },
    backofficeDbUrl: appUrl(TEST_DBS.shared, 'thapsus_backoffice'),
    fetch: globalThis.fetch,
    serviceRole: 'cell',
    mockIdp: true,
    ...opts.overrides,
  };
  const app = await buildApp(deps, { logger: process.env.TEST_LOG === '1' });
  if (opts.listen !== false) await app.listen({ port, host: '127.0.0.1' });
  else await app.ready();
  return {
    app,
    deps,
    mailer,
    directory,
    dnsRecords,
    clock,
    base,
    async close() {
      await app.close();
    },
  };
}

export async function closeDb() {
  await closeAllPools();
}

export const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
export const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

export function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const sid = list.map((c) => c.split(';')[0]).find((c) => c.startsWith('thr_sid='));
  if (!sid) throw new Error('no session cookie');
  return sid;
}

export const PASSWORD = 'Correct-Horse-Battery-9';

/** Signs up a fictional company and returns the owner's session cookie. */
export async function signup(ctx: TestContext, slug = uniq('acme'), region: HomeRegion = ctx.deps.config.cell) {
  const email = `owner@${slug}.example.test`;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/signup',
    remoteAddress: randomIp(),
    payload: { companyName: `Fictional ${slug} Ltd`, slug, region, ownerName: 'Olive Owner', ownerEmail: email, password: PASSWORD, acceptDpa: true },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed ${res.statusCode} ${res.body}`);
  const body = res.json() as { tenantId: string; userId: string };
  return { ...body, slug, email, cookie: cookieFrom(res) };
}

export function totpCode(secret: string, at: Date, offsetSteps = 0) {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: at.getTime() + offsetSteps * 30_000 });
}

/** Enrols and confirms TOTP for the session; returns the secret. */
export async function enrolTotp(ctx: TestContext, cookie: string) {
  const enrol = await ctx.app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/enroll', headers: { cookie } });
  if (enrol.statusCode !== 200) throw new Error(`enrol ${enrol.statusCode} ${enrol.body}`);
  const { secret } = enrol.json() as { secret: string };
  const confirm = await ctx.app.inject({ method: 'POST', url: '/v1/auth/mfa/totp/confirm', headers: { cookie }, payload: { code: totpCode(secret, ctx.clock.now) } });
  if (confirm.statusCode !== 204) throw new Error(`confirm ${confirm.statusCode} ${confirm.body}`);
  return secret;
}

/** Signs up and completes MFA, returning a fully privileged owner session. */
export async function ownerSession(ctx: TestContext, slug?: string) {
  const s = await signup(ctx, slug);
  const secret = await enrolTotp(ctx, s.cookie);
  return { ...s, totpSecret: secret };
}
