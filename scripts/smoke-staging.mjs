// `pnpm smoke:staging` — end-to-end checks against staging in each region (brief §8):
// sign up (choosing the region), SSO login, add an employee, request leave, clock in, export data.
//
//   node scripts/smoke-staging.mjs [--regions uk,eu,us] [--insecure-tls]
//
// URLs come from the staging deploy outputs (.deploy/ThapsusHr-staging-*.json, written by
// scripts/deploy.mjs) or from SMOKE_GLOBAL_URL and SMOKE_API_URL_UK / _EU / _US. --insecure-tls
// accepts the imported self-signed certificate staging uses until a domain exists (HUMAN_TODO 2.1);
// never use it against production. Every tenant it creates is fictional and is scheduled for
// closure at the end of the run.
import { existsSync, readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const value = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ENV = value('env') ?? 'staging';
if (ENV === 'prod') {
  console.error('smoke-staging never runs against production');
  process.exit(2);
}
if (args.includes('--insecure-tls')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const REGIONS = (value('regions') ?? 'uk,eu,us').split(',');
const PASSWORD = `Smoke-${Math.random().toString(36).slice(2, 10)}-Pw9!`;

const output = (stack, key) => {
  const f = `.deploy/${stack}.json`;
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8'))[stack]?.[key] : undefined;
};
const url = (envName, stack) =>
  process.env[envName] ??
  (output(stack, 'AlbDnsName') ? `https://${output(stack, 'AlbDnsName')}` : undefined);
const GLOBAL = url('SMOKE_GLOBAL_URL', `ThapsusHr-${ENV}-global`);
const API = Object.fromEntries(
  ['uk', 'eu', 'us'].map((r) => [r, url(`SMOKE_API_URL_${r.toUpperCase()}`, `ThapsusHr-${ENV}-cell-${r}`)]),
);

// ---- tiny HTTP client with a cookie jar per session -------------------------------------------------
class Session {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }
  async req(method, path, body, headers = {}) {
    const res = await fetch(path.startsWith('http') ? path : `${this.base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sid = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('thr_sid='));
    if (sid) this.cookie = sid;
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  }
}
const expectStatus = (r, status, what) => {
  if (r.status !== status)
    throw new Error(`${what}: expected ${status}, got ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
};

function totp(secretB32, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(msg).digest();
  const o = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const futureMonday = (weeks) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 * weeks + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
};

const COUNTRY = {
  uk: ['GB', 'GB-ENG', 'GBP', 'Europe/London'],
  eu: ['DE', 'DE-BE', 'EUR', 'Europe/Berlin'],
  us: ['US', 'US-CA', 'USD', 'America/Los_Angeles'],
};

async function smoke(region) {
  const api = API[region];
  if (!api)
    throw new Error(
      `no URL for the ${region} cell (deploy outputs or SMOKE_API_URL_${region.toUpperCase()})`,
    );
  const steps = [];
  smoke.lastSteps = steps;
  const step = async (name, fn) => {
    const t = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t, detail });
    } catch (err) {
      steps.push({ name, ok: false, ms: Date.now() - t, detail: String(err.message ?? err) });
      throw err;
    }
  };
  const slug = `smoke-${region}-${Date.now().toString(36)}`;
  const email = `owner@${slug}.example.test`;
  const owner = new Session(api);
  const ctx = {};
  try {
    await step('sign up (choose region)', async () => {
      const other = REGIONS.find((r) => r !== region && API[r]) ?? (region === 'uk' ? 'eu' : 'uk');
      // a cell refuses sign-ups for another region and points to the right one
      const wrong = await new Session(api).req('POST', '/v1/signup', {
        companyName: `Fictional ${slug} Ltd`,
        slug: `${slug}-x`,
        region: other,
        ownerName: 'Sam Smoke',
        ownerEmail: `x@${slug}.example.test`,
        password: PASSWORD,
        acceptDpa: true,
      });
      expectStatus(wrong, 421, 'wrong-region sign-up');
      const r = expectStatus(
        await owner.req('POST', '/v1/signup', {
          companyName: `Fictional ${slug} Ltd`,
          slug,
          region,
          ownerName: 'Sam Smoke',
          ownerEmail: email,
          password: PASSWORD,
          acceptDpa: true,
        }),
        201,
        'sign-up',
      );
      ctx.tenantId = r.tenantId;
      if (GLOBAL) {
        const resolved = await new Session(GLOBAL).req('GET', `/global/v1/resolve?slug=${slug}`);
        if (expectStatus(resolved, 200, 'global resolve').region !== region)
          throw new Error('global directory resolved the wrong region');
      }
      return `tenant in ${region}`;
    });
    await step('owner MFA (TOTP)', async () => {
      const { secret } = expectStatus(await owner.req('POST', '/v1/auth/mfa/totp/enroll'), 200, 'enrol');
      ctx.totp = secret;
      expectStatus(
        await owner.req('POST', '/v1/auth/mfa/totp/confirm', { code: totp(secret) }),
        204,
        'confirm',
      );
    });
    await step('SSO login (OIDC, mock IdP)', async () => {
      // The mock IdP names its own issuer: the public URL once a domain exists, otherwise the in-task
      // address the API can reach without the self-signed certificate (MOCK_IDP_ISSUER_URL).
      const { issuer } = expectStatus(
        await new Session(api).req('GET', '/__mock-idp/.well-known/openid-configuration'),
        200,
        'mock IdP discovery',
      );
      const conn = expectStatus(
        await owner.req('POST', '/v1/settings/sso-connections', {
          protocol: 'oidc',
          name: 'Smoke mock OIDC',
          oidc: {
            issuer,
            clientId: 'thapsus-smoke-client',
            clientSecret: 'smoke-only', // fictional; the mock IdP does not check it
          },
        }),
        201,
        'create connection',
      );
      const sso = new Session(api);
      const start = await sso.req(
        'GET',
        `/v1/auth/sso/start?tenant=${slug}&connection=${conn.id}&login_hint=${encodeURIComponent(email)}`,
      );
      if (start.status !== 302) throw new Error(`sso start ${start.status}`);
      // the browser leg always goes through the public URL, whatever address the issuer names
      const authorize = start.headers.get('location').replace(new URL(issuer).origin, api);
      const idp = await sso.req('GET', authorize);
      const cb = await sso.req('GET', idp.headers.get('location'));
      if (cb.status !== 302) throw new Error(`sso callback ${cb.status} ${cb.text.slice(0, 200)}`);
      const me = expectStatus(await sso.req('GET', '/v1/auth/session'), 200, 'sso session');
      if (me.method !== 'oidc' || me.email !== email) throw new Error('unexpected SSO session');
      return 'oidc session';
    });
    await step('add employee', async () => {
      const [country, regionCode, currency, timeZone] = COUNTRY[region];
      const entity = expectStatus(
        await owner.req('POST', '/v1/org/legal-entities', {
          name: `Fictional ${slug} Entity`,
          country,
          regionCode,
          currency,
          timeZone,
        }),
        201,
        'legal entity',
      );
      const emp = expectStatus(
        await owner.req('POST', '/v1/employees', {
          startDate: '2025-01-06',
          legalFirstName: 'Riley',
          legalLastName: 'Smoketest',
          jobTitle: 'Analyst',
          entityId: entity.id,
          weeklyHours: 37.5,
          payAmountMinor: 3_000_000,
          payCurrency: currency,
          payFrequency: 'annual',
          contractType: 'permanent',
        }),
        201,
        'employee',
      );
      ctx.employeeId = emp.id;
      ctx.employeeNumber = expectStatus(
        await owner.req('GET', `/v1/employees/${emp.id}`),
        200,
        'read employee',
      ).employee.employeeNumber;
      return emp.id;
    });
    await step('request leave', async () => {
      const types = expectStatus(await owner.req('GET', '/v1/leave/types'), 200, 'leave types');
      const annual = types.find((t) => t.key === 'annual');
      const start = futureMonday(4);
      const r = expectStatus(
        await owner.req('POST', '/v1/leave/requests', {
          employeeId: ctx.employeeId,
          leaveTypeId: annual.id,
          startDate: start,
          endDate: start,
        }),
        201,
        'leave request',
      );
      return `${r.status}, ${r.amountDays} day`;
    });
    await step('clock in (shared kiosk with PIN)', async () => {
      const kiosk = expectStatus(
        await owner.req('POST', '/v1/kiosks', { name: 'Smoke kiosk' }),
        201,
        'kiosk',
      );
      expectStatus(
        await owner.req('PUT', `/v1/kiosk-pins/${ctx.employeeId}`, { pin: '4827' }),
        204,
        'set PIN',
      );
      const device = new Session(api);
      const r = expectStatus(
        await device.req(
          'POST',
          '/v1/kiosk/clock',
          {
            employeeNumber: ctx.employeeNumber,
            pin: '4827',
            kind: 'in',
            clientEventId: `smoke:${Date.now().toString(36)}`,
          },
          { authorization: `Kiosk ${kiosk.token}` },
        ),
        200,
        'kiosk clock',
      );
      return JSON.stringify(r).slice(0, 80);
    });
    await step('export data', async () => {
      const csv = await owner.req('GET', '/v1/exports/employees?format=csv');
      if (csv.status !== 200 || !/Smoketest/.test(csv.text)) throw new Error(`employee export ${csv.status}`);
      const range = `from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`;
      const audit = await owner.req('GET', `/v1/audit/events?${range}&format=json`);
      if (audit.status !== 200 || !Array.isArray(audit.json) || !audit.json.length)
        throw new Error(`audit export ${audit.status}`);
      return `${csv.text.split('\n').length - 1} rows, ${audit.json.length} audit events`;
    });
  } finally {
    // tidy up: schedule the fictional tenant for closure (grace period, then verified deletion)
    if (ctx.tenantId)
      await owner
        .req('POST', '/v1/privacy/closure', { confirmWorkspace: slug, reason: 'staging smoke test' })
        .catch(() => undefined);
  }
  return steps;
}

let failed = false;
const report = [];
for (const region of REGIONS) {
  console.log(`\n== ${ENV} ${region} (${API[region] ?? 'no URL'}) ==`);
  try {
    const steps = await smoke(region);
    for (const s of steps)
      console.log(`  PASS ${s.name.padEnd(36)} ${String(s.ms).padStart(6)} ms  ${s.detail ?? ''}`);
    report.push({ region, ok: true });
  } catch (err) {
    for (const s of smoke.lastSteps ?? [])
      console.log(
        `  ${s.ok ? 'PASS' : 'FAIL'} ${s.name.padEnd(36)} ${String(s.ms).padStart(6)} ms  ${s.ok ? (s.detail ?? '') : ''}`,
      );
    console.log(`  FAIL ${err.message}`);
    report.push({ region, ok: false, error: err.message });
    failed = true;
  }
}
console.log('\nThapsus-HR staging smoke summary');
for (const r of report) console.log(`  ${r.region.padEnd(4)} ${r.ok ? 'PASS' : `FAIL  ${r.error}`}`);
process.exit(failed ? 1 : 0);
