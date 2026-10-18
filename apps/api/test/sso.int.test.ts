import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerSession, PASSWORD, startTestApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

type Owner = Awaited<ReturnType<typeof ownerSession>>;

async function verifyDomain(owner: Owner) {
  const domain = `${owner.slug}.example.test`;
  const add = await ctx.app.inject({ method: 'POST', url: '/v1/settings/domains', headers: { cookie: owner.cookie }, payload: { domain } });
  expect(add.statusCode).toBe(201);
  const d = add.json() as { id: string; txtName: string; txtValue: string };
  const notYet = await ctx.app.inject({ method: 'POST', url: `/v1/settings/domains/${d.id}/verify`, headers: { cookie: owner.cookie } });
  expect(notYet.statusCode).toBe(422);
  ctx.dnsRecords.set(d.txtName, [[d.txtValue.slice(0, 10), d.txtValue.slice(10)]]); // TXT records may be chunked
  const ok = await ctx.app.inject({ method: 'POST', url: `/v1/settings/domains/${d.id}/verify`, headers: { cookie: owner.cookie } });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().verifiedAt).toBeTruthy();
  return domain;
}

async function createConnection(owner: Owner, protocol: 'oidc' | 'saml') {
  const info = (ctx.app as unknown as { mockIdpInfo: () => { issuer: string; samlEntryPoint: string; certPem: string } }).mockIdpInfo();
  const payload =
    protocol === 'oidc'
      ? { protocol, name: 'Mock OIDC', oidc: { issuer: info.issuer, clientId: 'thapsus-test-client', clientSecret: 'fictional-client-secret' } }
      : { protocol, name: 'Mock SAML', saml: { entryPoint: info.samlEntryPoint, idpIssuer: info.issuer, idpCert: info.certPem } };
  const res = await ctx.app.inject({ method: 'POST', url: '/v1/settings/sso-connections', headers: { cookie: owner.cookie }, payload });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const go = (url: string, init: RequestInit = {}) => fetch(url, { redirect: 'manual', ...init });
const sid = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('thr_sid='));

async function oidcLogin(slug: string, connection: string, email: string) {
  const start = await go(`${ctx.base}/v1/auth/sso/start?tenant=${slug}&connection=${connection}&login_hint=${encodeURIComponent(email)}`);
  expect(start.status).toBe(302);
  const idp = await go(start.headers.get('location')!);
  expect(idp.status).toBe(302);
  return go(idp.headers.get('location')!);
}

async function samlAssertion(slug: string, connection: string, email: string) {
  const start = await go(`${ctx.base}/v1/auth/sso/start?tenant=${slug}&connection=${connection}&login_hint=${encodeURIComponent(email)}`);
  expect(start.status).toBe(302);
  const html = await (await go(start.headers.get('location')!)).text();
  const field = (n: string) => new RegExp(`name="${n}" value="([^"]*)"`).exec(html)![1]!;
  return { SAMLResponse: field('SAMLResponse'), RelayState: field('RelayState') };
}

const postAcs = (form: Record<string, string>) =>
  go(`${ctx.base}/v1/auth/sso/saml/acs`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });

describe('OIDC single sign-on (mock IdP)', () => {
  it('signs in end to end and just-in-time provisions users from a verified domain', async () => {
    const owner = await ownerSession(ctx);
    const domain = await verifyDomain(owner);
    const conn = await createConnection(owner, 'oidc');
    const cb = await oidcLogin(owner.slug, conn, `jit.person@${domain}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('http://localhost:3000/app');
    const cookie = sid(cb)!;
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    expect(me.json()).toMatchObject({ email: `jit.person@${domain}`, method: 'oidc', roles: ['employee'] });
  });

  it('refuses users from unverified domains (no JIT) and replayed state', async () => {
    const owner = await ownerSession(ctx);
    const conn = await createConnection(owner, 'oidc');
    const cb = await oidcLogin(owner.slug, conn, 'outsider@elsewhere.example.test');
    expect(cb.status).toBe(403);
    const ok = await oidcLogin(owner.slug, conn, owner.email);
    expect(ok.status).toBe(302);
    // the same callback URL (state + code) cannot be used twice
    expect((await go(ok.url)).status).toBe(401);
  });
});

describe('SAML 2.0 single sign-on (mock IdP)', () => {
  it('signs in end to end with a signed assertion', async () => {
    const owner = await ownerSession(ctx);
    const conn = await createConnection(owner, 'saml');
    const form = await samlAssertion(owner.slug, conn, owner.email);
    const res = await postAcs(form);
    expect(res.status).toBe(302);
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: sid(res)! } });
    expect(me.json()).toMatchObject({ email: owner.email, method: 'saml' });
    const meta = await ctx.app.inject({ method: 'GET', url: `/v1/auth/sso/saml/metadata/${owner.tenantId}/${conn}` });
    expect(meta.body).toContain('AssertionConsumerService');
  });

  it('rejects tampered and replayed assertions', async () => {
    const owner = await ownerSession(ctx);
    const conn = await createConnection(owner, 'saml');
    const form = await samlAssertion(owner.slug, conn, owner.email);
    const xml = Buffer.from(form.SAMLResponse, 'base64').toString();
    const tampered = Buffer.from(xml.replace(owner.email, 'attacker@evil.example.test')).toString('base64');
    expect((await postAcs({ ...form, SAMLResponse: tampered })).status).toBe(401);

    const good = await samlAssertion(owner.slug, conn, owner.email);
    expect((await postAcs(good)).status).toBe(302);
    const fresh = await samlAssertion(owner.slug, conn, owner.email);
    expect((await postAcs({ SAMLResponse: good.SAMLResponse, RelayState: fresh.RelayState })).status).toBe(401);
  });
});

describe('SSO enforcement', () => {
  it('after a tenant enforces SSO, password and magic-link sign-in are refused but SSO works', async () => {
    const owner = await ownerSession(ctx);
    const noConn = await ctx.app.inject({ method: 'PATCH', url: '/v1/settings/security', headers: { cookie: owner.cookie }, payload: { ssoEnforced: true } });
    expect(noConn.statusCode).toBe(422);
    const conn = await createConnection(owner, 'oidc');
    const enforce = await ctx.app.inject({ method: 'PATCH', url: '/v1/settings/security', headers: { cookie: owner.cookie }, payload: { ssoEnforced: true } });
    expect(enforce.statusCode).toBe(200);

    const pw = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: owner.slug, email: owner.email, password: PASSWORD }, remoteAddress: '10.9.9.9' });
    expect(pw.statusCode).toBe(403);
    expect(pw.json().code).toBe('ssoRequired');
    const magic = await ctx.app.inject({ method: 'POST', url: '/v1/auth/magic-link', payload: { tenant: owner.slug, email: owner.email } });
    expect(magic.statusCode).toBe(403);
    const passkey = await ctx.app.inject({ method: 'POST', url: '/v1/auth/passkeys/login/options', payload: { tenant: owner.slug } });
    expect(passkey.statusCode).toBe(403);
    expect((await oidcLogin(owner.slug, conn, owner.email)).status).toBe(302);
  });
});
