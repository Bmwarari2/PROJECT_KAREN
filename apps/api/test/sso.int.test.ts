import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import { closeDb, ownerSession, PASSWORD, startTestApp, type TestContext } from './helpers';
import { idpAssertedMfa, samlAuthnContext } from '../src/modules/auth/sso';
import { onSecurityEvent, type SecurityEvent } from '../src/lib/security-events';

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
  const add = await ctx.app.inject({
    method: 'POST',
    url: '/v1/settings/domains',
    headers: { cookie: owner.cookie },
    payload: { domain },
  });
  expect(add.statusCode).toBe(201);
  const d = add.json() as { id: string; txtName: string; txtValue: string };
  const notYet = await ctx.app.inject({
    method: 'POST',
    url: `/v1/settings/domains/${d.id}/verify`,
    headers: { cookie: owner.cookie },
  });
  expect(notYet.statusCode).toBe(422);
  ctx.dnsRecords.set(d.txtName, [[d.txtValue.slice(0, 10), d.txtValue.slice(10)]]); // TXT records may be chunked
  const ok = await ctx.app.inject({
    method: 'POST',
    url: `/v1/settings/domains/${d.id}/verify`,
    headers: { cookie: owner.cookie },
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().verifiedAt).toBeTruthy();
  return domain;
}

async function createConnection(owner: Owner, protocol: 'oidc' | 'saml') {
  const info = (
    ctx.app as unknown as { mockIdpInfo: () => { issuer: string; samlEntryPoint: string; certPem: string } }
  ).mockIdpInfo();
  const payload =
    protocol === 'oidc'
      ? {
          protocol,
          name: 'Mock OIDC',
          oidc: {
            issuer: info.issuer,
            clientId: 'thapsus-test-client',
            clientSecret: 'fictional-client-secret',
          },
        }
      : {
          protocol,
          name: 'Mock SAML',
          saml: { entryPoint: info.samlEntryPoint, idpIssuer: info.issuer, idpCert: info.certPem },
        };
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/settings/sso-connections',
    headers: { cookie: owner.cookie },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const go = (url: string, init: RequestInit = {}) => fetch(url, { redirect: 'manual', ...init });
const sid = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith('thr_sid='));

/** The browser-binding cookie set when the sign-in starts (ASVS V10.1.2). */
const binding = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith('thr_sso='));

/** Mock IdP test controls (dev/test only): `mock_amr`, `mock_sub`, `mock_authn_context`, `mock_nameid`. */
type IdpControls = Record<string, string>;
const withControls = (url: string, controls: IdpControls = {}) => {
  const u = new URL(url);
  for (const [k, v] of Object.entries(controls)) u.searchParams.set(k, v);
  return u.href;
};

async function oidcLogin(
  slug: string,
  connection: string,
  email: string,
  opts: { otherBrowser?: boolean; idp?: IdpControls } = {},
) {
  const start = await go(
    `${ctx.base}/v1/auth/sso/start?tenant=${slug}&connection=${connection}&login_hint=${encodeURIComponent(email)}`,
  );
  expect(start.status).toBe(302);
  const cookie = binding(start);
  expect(cookie).toBeTruthy();
  const idp = await go(withControls(start.headers.get('location')!, opts.idp));
  expect(idp.status).toBe(302);
  return go(idp.headers.get('location')!, opts.otherBrowser ? {} : { headers: { cookie: cookie! } });
}

async function samlAssertion(slug: string, connection: string, email: string, idp: IdpControls = {}) {
  const start = await go(
    `${ctx.base}/v1/auth/sso/start?tenant=${slug}&connection=${connection}&login_hint=${encodeURIComponent(email)}`,
  );
  expect(start.status).toBe(302);
  const html = await (await go(withControls(start.headers.get('location')!, idp))).text();
  const field = (n: string) => new RegExp(`name="${n}" value="([^"]*)"`).exec(html)![1]!;
  return { SAMLResponse: field('SAMLResponse'), RelayState: field('RelayState'), binding: binding(start)! };
}

/** The IdP's page posts the assertion cross-site (no cookies), as a browser would. */
const postAcs = (form: { SAMLResponse: string; RelayState: string }) =>
  go(`${ctx.base}/v1/auth/sso/saml/acs`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: form.SAMLResponse, RelayState: form.RelayState }).toString(),
  });

/** ACS, then the same-site hand-over that must carry the browser binding (ADR-0172). */
async function samlLogin(
  form: { SAMLResponse: string; RelayState: string; binding: string },
  cookie = form.binding,
) {
  const acs = await postAcs(form);
  if (acs.status !== 303) return acs;
  expect(acs.headers.get('location')).toMatch(/\/v1\/auth\/sso\/saml\/finish\?state=/);
  return go(acs.headers.get('location')!, cookie ? { headers: { cookie } } : {});
}

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

  it('only the browser that started the sign-in can finish it (no login CSRF), and failures are audited', async () => {
    const owner = await ownerSession(ctx);
    const conn = await createConnection(owner, 'oidc');
    const elsewhere = await oidcLogin(owner.slug, conn, owner.email, { otherBrowser: true });
    expect(elsewhere.status).toBe(401);
    expect(sid(elsewhere)).toBeUndefined();
    const { withTenant } = await import('@thapsus/db');
    const rows = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
      tx.query<{ diff: unknown }>(`SELECT diff FROM audit.events WHERE action = 'auth.login_failed'`),
    );
    expect(rows.map((r) => r.diff)).toContainEqual({
      method: 'oidc',
      reason: 'invalidCredentials',
      detail: 'browserBinding',
    });
  });
});

describe('SAML 2.0 single sign-on (mock IdP)', () => {
  it('signs in end to end with a signed assertion', async () => {
    const owner = await ownerSession(ctx);
    const conn = await createConnection(owner, 'saml');
    const form = await samlAssertion(owner.slug, conn, owner.email);
    const res = await samlLogin(form);
    expect(res.status).toBe(302);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie: sid(res)! },
    });
    expect(me.json()).toMatchObject({ email: owner.email, method: 'saml' });
    const meta = await ctx.app.inject({
      method: 'GET',
      url: `/v1/auth/sso/saml/metadata/${owner.tenantId}/${conn}`,
    });
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
    expect((await samlLogin(good)).status).toBe(302);
    const fresh = await samlAssertion(owner.slug, conn, owner.email);
    expect((await postAcs({ SAMLResponse: good.SAMLResponse, RelayState: fresh.RelayState })).status).toBe(
      401,
    );
    // a response signed with SHA-1 is refused (ASVS V11.4.1)
    const weak = await samlAssertion(owner.slug, conn, owner.email);
    const sha1 = Buffer.from(
      Buffer.from(weak.SAMLResponse, 'base64')
        .toString()
        .replaceAll(
          'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
          'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
        ),
    ).toString('base64');
    expect((await postAcs({ ...weak, SAMLResponse: sha1 })).status).toBe(401);
  });
});

describe('SSO enforcement', () => {
  it('after a tenant enforces SSO, password and magic-link sign-in are refused but SSO works', async () => {
    const owner = await ownerSession(ctx);
    const noConn = await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/settings/security',
      headers: { cookie: owner.cookie },
      payload: { ssoEnforced: true },
    });
    expect(noConn.statusCode).toBe(422);
    const conn = await createConnection(owner, 'oidc');
    const enforce = await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/settings/security',
      headers: { cookie: owner.cookie },
      payload: { ssoEnforced: true },
    });
    expect(enforce.statusCode).toBe(200);

    const pw = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { tenant: owner.slug, email: owner.email, password: PASSWORD },
      remoteAddress: '10.9.9.9',
    });
    expect(pw.statusCode).toBe(403);
    expect(pw.json().code).toBe('ssoRequired');
    const magic = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { tenant: owner.slug, email: owner.email },
    });
    expect(magic.statusCode).toBe(403);
    const passkey = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/passkeys/login/options',
      payload: { tenant: owner.slug },
    });
    expect(passkey.statusCode).toBe(403);
    expect((await oidcLogin(owner.slug, conn, owner.email)).status).toBe(302);
  });
});

describe('SSO identity binding and IdP-asserted MFA (plan 2.1.3)', () => {
  const sessionOf = async (res: Response) =>
    (await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: sid(res)! } })).json();

  it('links the person to (connection, issuer, subject) at the first sign-in and refuses a changed subject for the same email', async () => {
    const events: SecurityEvent[] = [];
    const stop = onSecurityEvent((e) => void events.push(e));
    try {
      const owner = await ownerSession(ctx);
      const domain = await verifyDomain(owner);
      const conn = await createConnection(owner, 'oidc');
      const email = `bound.person@${domain}`;
      const first = await oidcLogin(owner.slug, conn, email, { idp: { mock_sub: 'fictional-sub-1' } });
      expect(first.status).toBe(302);
      const bound = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
        tx.query<{ issuer: string; subject: string }>('SELECT issuer, subject FROM app.sso_identities'),
      );
      expect(bound).toEqual([{ issuer: expect.stringMatching(/__mock-idp$/), subject: 'fictional-sub-1' }]);
      expect(
        (await oidcLogin(owner.slug, conn, email, { idp: { mock_sub: 'fictional-sub-1' } })).status,
      ).toBe(302);
      // the IdP now says another account has that email: refused, audited and a high-severity event
      const swapped = await oidcLogin(owner.slug, conn, email, { idp: { mock_sub: 'fictional-sub-2' } });
      expect(swapped.status).toBe(403);
      expect(sid(swapped)).toBeUndefined();
      const failed = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
        tx.query<{ diff: unknown }>(`SELECT diff FROM audit.events WHERE action = 'auth.login_failed'`),
      );
      expect(failed.map((r) => r.diff)).toContainEqual({
        method: 'oidc',
        reason: 'forbidden',
        detail: 'ssoSubjectChanged',
      });
      expect(events.find((e) => e.type === 'auth.sso_subject_mismatch')).toMatchObject({ severity: 'high' });
      const userIds = await withTenant(ctx.deps.router, owner.tenantId, (tx) =>
        tx.query<{ user_id: string }>('SELECT user_id FROM app.sso_identities'),
      );
      // an admin who may reset the person's sign-in unlinks them; the next sign-in links the new subject
      const unlink = await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/users/${userIds[0]!.user_id}/sso-identities`,
        headers: { cookie: owner.cookie },
      });
      expect(unlink.statusCode, unlink.body).toBe(200);
      expect(unlink.json()).toEqual({ unlinked: 1 });
      expect(
        (await oidcLogin(owner.slug, conn, email, { idp: { mock_sub: 'fictional-sub-2' } })).status,
      ).toBe(302);
      expect(
        (
          await ctx.app.inject({
            method: 'GET',
            url: `/v1/users/${userIds[0]!.user_id}/sso-identities`,
            headers: { cookie: owner.cookie },
          })
        ).json(),
      ).toEqual([expect.objectContaining({ connectionId: conn, connectionName: 'Mock OIDC' })]);
    } finally {
      stop();
    }
  });

  it('counts an SSO sign-in as two-step only when the workspace trusts its IdP AND the IdP asserts MFA (amr/acr); trust is off by default', async () => {
    const owner = await ownerSession(ctx);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/v1/settings/security',
          headers: { cookie: owner.cookie },
        })
      ).json().trustIdpMfa,
    ).toBe(false);
    const oidcConn = await createConnection(owner, 'oidc');
    const samlConn = await createConnection(owner, 'saml');
    // trust off: even an IdP-asserted MFA leaves the owner to use their own authenticator here
    const off = await oidcLogin(owner.slug, oidcConn, owner.email, { idp: { mock_amr: 'pwd,mfa' } });
    expect(await sessionOf(off)).toMatchObject({ method: 'oidc', mfaVerified: false });
    // trusting the IdP is a weakening: it needs a recent sign-in, which the owner has
    const trust = await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/settings/security',
      headers: { cookie: owner.cookie },
      payload: { trustIdpMfa: true },
    });
    expect(trust.statusCode).toBe(200);
    for (const [amr, verified] of [
      ['pwd', false],
      ['pwd,mfa', true],
      ['pwd,otp', true],
      ['hwk', true],
    ] as const) {
      const r = await oidcLogin(owner.slug, oidcConn, owner.email, { idp: { mock_amr: amr } });
      expect((await sessionOf(r)).mfaVerified, amr).toBe(verified);
    }
    expect((await sessionOf(await oidcLogin(owner.slug, oidcConn, owner.email))).mfaVerified).toBe(false); // no amr
    const pwd = await samlAssertion(owner.slug, samlConn, owner.email);
    expect((await sessionOf(await samlLogin(pwd))).mfaVerified).toBe(false);
    const mfa = await samlAssertion(owner.slug, samlConn, owner.email, {
      mock_authn_context: 'urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract',
    });
    expect((await sessionOf(await samlLogin(mfa))).mfaVerified).toBe(true);
    expect(idpAssertedMfa({ acr: 'http://schemas.microsoft.com/claims/multipleauthn' })).toBe(true);
    expect(idpAssertedMfa({ amr: ['pwd', 'kba'] })).toBe(false);
    expect(samlAuthnContext('<x:AuthnContextClassRef> urn:a </x:AuthnContextClassRef>')).toBe('urn:a');
  });

  it('binds SAML to the browser that started the sign-in: the hand-over without its cookie is refused', async () => {
    const owner = await ownerSession(ctx);
    const conn = await createConnection(owner, 'saml');
    const form = await samlAssertion(owner.slug, conn, owner.email);
    const elsewhere = await samlLogin(form, '');
    expect(elsewhere.status).toBe(401);
    expect(sid(elsewhere)).toBeUndefined();
    // the hand-over cannot be replayed with the cookie afterwards either (one use)
    const form2 = await samlAssertion(owner.slug, conn, owner.email);
    const acs = await postAcs(form2);
    expect(acs.status).toBe(303);
    const finish = acs.headers.get('location')!;
    expect((await go(finish, { headers: { cookie: form2.binding } })).status).toBe(302);
    expect((await go(finish, { headers: { cookie: form2.binding } })).status).toBe(401);
    // a persistent NameID binds like an OIDC subject (on a second connection: bindings are per connection)
    const conn2 = await createConnection(owner, 'saml');
    const persistent = await samlAssertion(owner.slug, conn2, owner.email, {
      mock_nameid: 'fictional-persistent-1',
    });
    expect((await samlLogin(persistent)).status).toBe(302);
    const changed = await samlAssertion(owner.slug, conn2, owner.email, {
      mock_nameid: 'fictional-persistent-2',
    });
    expect((await samlLogin(changed)).status).toBe(403);
  });
});
