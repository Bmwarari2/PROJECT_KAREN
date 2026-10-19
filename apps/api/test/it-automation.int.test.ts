import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importSPKI, jwtVerify } from 'jose';
import { addDays, startOfDayInstant, today } from '@thapsus/core/time';
import { closeDb, startTestApp, type TestContext } from './helpers';
import { mockProviders, phase6Company, type MockProviders, type Phase6Company, type RecordedCall } from './phase6-fixtures';

/**
 * PROGRESS 6.4: Microsoft 365 (Graph) and Google Workspace (Admin SDK) joiner/leaver automation against
 * mocks that check the official request shapes. Per-customer admin consent, sealed credentials,
 * mapping rules, an exact dry run, lifecycle events → idempotent jobs at the right time, execution log
 * and audit. Dates are relative to today, so nothing depends on the calendar.
 */
let ctx: TestContext;
let c: Phase6Company;
let mock: MockProviders;
const ENTRA_TENANT = '9b4c2d1e-0000-4000-8000-00000000e17a';
const APP_ID = '3f2a1b0c-0000-4000-8000-0000000a99c1';
const E3 = '05e9a617-0261-4cee-bb44-138d3ef5d965';
const ALL_STAFF = '1a2b3c4d-0000-4000-8000-00000000a11a';
const ENG_GROUP = '1a2b3c4d-0000-4000-8000-00000000e9e9';
const day = today('Europe/London');
let engineering: string;
const graphCalls = () => mock.calls.filter((x) => x.url.startsWith('https://graph.microsoft.com/'));
const googleCalls = () => mock.calls.filter((x) => /googleapis\.com\/(admin|apps)/.test(x.url));

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const SERVICE_ACCOUNT = { type: 'service_account', client_email: 'thapsus-hr@fictional-project.iam.gserviceaccount.com', client_id: '108765432109876543210', private_key: privateKey };
let googleTokenClaims: Record<string, unknown> | undefined;
const graphUsers = new Map<string, { id: string; employeeId: string }>();
let failGroupOnce = false;

beforeAll(async () => {
  mock = mockProviders();
  // ---- Microsoft identity platform + Graph ----
  mock.on('POST', /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/oauth2\/v2\.0\/token$/, (call, m) => (m[1] === ENTRA_TENANT && call.form?.client_secret === 'fictional-entra-secret' ? { status: 200, json: { access_token: 'graph-token', token_type: 'Bearer', expires_in: 3599 } } : { status: 401, json: { error: 'invalid_client' } }));
  mock.on('POST', /^https:\/\/graph\.microsoft\.com\/v1\.0\/users$/, (call) => {
    const b = call.json as { userPrincipalName: string; employeeId: string };
    if (graphUsers.has(b.userPrincipalName)) return { status: 400, json: { error: { code: 'Request_BadRequest', message: 'Another object with the same value for property userPrincipalName already exists.' } } };
    const id = `aad-${graphUsers.size + 1}`;
    graphUsers.set(b.userPrincipalName, { id, employeeId: b.employeeId });
    return { status: 201, json: { id, userPrincipalName: b.userPrincipalName } };
  });
  mock.on('GET', /^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/([^/?]+)\?\$select=id,employeeId$/, (_c, m) => {
    const u = graphUsers.get(decodeURIComponent(m[1]!));
    return u ? { status: 200, json: { id: u.id, employeeId: u.employeeId } } : { status: 404, json: { error: { code: 'Request_ResourceNotFound' } } };
  });
  mock.on('POST', /^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/[^/]+\/assignLicense$/, () => ({ status: 200, json: { id: 'x' } }));
  mock.on('POST', /^https:\/\/graph\.microsoft\.com\/v1\.0\/groups\/[^/]+\/members\/\$ref$/, () => {
    if (failGroupOnce) {
      failGroupOnce = false;
      return { status: 503, json: { error: { code: 'serviceNotAvailable' } } };
    }
    return { status: 204 };
  });
  mock.on('PATCH', /^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/[^/]+$/, () => ({ status: 204 }));
  mock.on('POST', /^https:\/\/graph\.microsoft\.com\/v1\.0\/users\/[^/]+\/revokeSignInSessions$/, () => ({ status: 200, json: { value: true } }));
  // ---- Google OAuth (JWT bearer) + Admin SDK Directory + Enterprise License Manager ----
  mock.on('POST', /^https:\/\/oauth2\.googleapis\.com\/token$/, async (call) => {
    if (call.form?.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return { status: 400, json: { error: 'unsupported_grant_type' } };
    const { payload, protectedHeader } = await jwtVerify(call.form.assertion!, await importSPKI(publicKey, 'RS256'), { audience: 'https://oauth2.googleapis.com/token' });
    googleTokenClaims = { ...payload, alg: protectedHeader.alg };
    return { status: 200, json: { access_token: 'google-token', expires_in: 3600, token_type: 'Bearer' } };
  });
  mock.on('POST', /^https:\/\/admin\.googleapis\.com\/admin\/directory\/v1\/users$/, (call) => ({ status: 200, json: { id: '1047', primaryEmail: (call.json as { primaryEmail: string }).primaryEmail } }));
  mock.on('POST', /^https:\/\/licensing\.googleapis\.com\/apps\/licensing\/v1\/product\/[^/]+\/sku\/[^/]+\/user$/, () => ({ status: 200, json: { kind: 'licensing#licenseAssignment' } }));
  mock.on('DELETE', /^https:\/\/licensing\.googleapis\.com\/apps\/licensing\/v1\/product\/[^/]+\/sku\/[^/]+\/user\/[^/]+$/, () => ({ status: 204 }));
  mock.on('POST', /^https:\/\/admin\.googleapis\.com\/admin\/directory\/v1\/groups\/[^/]+\/members$/, () => ({ status: 200, json: { kind: 'admin#directory#member' } }));
  mock.on('PATCH', /^https:\/\/admin\.googleapis\.com\/admin\/directory\/v1\/users\/[^/]+$/, () => ({ status: 200, json: { suspended: true } }));
  mock.on('POST', /^https:\/\/admin\.googleapis\.com\/admin\/directory\/v1\/users\/[^/]+\/signOut$/, () => ({ status: 204 }));

  ctx = await startTestApp({ listen: false, overrides: { fetch: mock.fetch } });
  c = await phase6Company(ctx);
  engineering = await c.post('/v1/org/departments', { name: 'Engineering' });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

const requestOf = (x: RecordedCall) => ({ method: x.method, url: x.url, body: x.json ?? null });

describe('Microsoft 365 connection with per-customer admin consent', () => {
  it('stores the client secret sealed and connects through the admin-consent redirect', async () => {
    const put = await c.api('PUT', '/v1/integrations/it/microsoft365', { domain: 'fictional.example', clientId: APP_ID, settings: { joinerLeadDays: 3 } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ provider: 'microsoft365', status: 'pending_consent', scopes: ['User.Create', 'User.Read.All', 'User.EnableDisableAccount.All', 'User.RevokeSessions.All', 'LicenseAssignment.ReadWrite.All', 'GroupMember.ReadWrite.All'] });
    expect((await c.api('PUT', '/v1/integrations/it/microsoft365/credentials', { clientSecret: 'fictional-entra-secret' })).json()).toEqual({ configured: ['clientSecret'] });
    const raw = await c.tx((t) => t.one<{ envelope: unknown }>(`SELECT envelope FROM app.integration_credentials WHERE owner_type = 'it_connection'`));
    expect(JSON.stringify(raw.envelope)).not.toContain('fictional-entra-secret');
    const consent = (await c.api('POST', '/v1/integrations/it/microsoft365/consent')).json();
    const u = new URL(consent.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://login.microsoftonline.com/organizations/v2.0/adminconsent');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: APP_ID, scope: 'https://graph.microsoft.com/.default', redirect_uri: 'http://localhost:3000/v1/integrations/it/microsoft365/consent-callback' });
    const back = await c.api('GET', `/v1/integrations/it/microsoft365/consent-callback?admin_consent=True&tenant=${ENTRA_TENANT}&state=${u.searchParams.get('state')}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default`);
    expect(back.statusCode, back.body).toBe(302);
    expect(back.headers.location).toBe('http://localhost:3000/app/integrations?consent=granted');
    const status = (await c.api('GET', '/v1/integrations/it')).json().find((x: { provider: string }) => x.provider === 'microsoft365');
    expect(status).toMatchObject({ status: 'connected', directoryId: ENTRA_TENANT, credentials: ['clientSecret'] });
    expect((await c.api('POST', '/v1/integrations/it/microsoft365/verify')).statusCode).toBe(200);
    for (const rule of [
      { name: 'Everyone', priority: 10, match: {}, licences: [{ skuId: E3 }], groups: [ALL_STAFF] },
      { name: 'Engineering', priority: 20, match: { departmentId: engineering }, licences: [], groups: [ENG_GROUP] },
    ])
      expect((await c.api('POST', '/v1/integrations/it/microsoft365/rules', rule)).statusCode).toBe(201);
  });
});

let joiner: string;
let joinerNumber: string;
let preview: { principalName: string; operations: Array<{ seq: number; op: string; method: string; url: string; body?: Record<string, unknown> }> };

describe('Microsoft 365 joiner', () => {
  it('the dry run shows the exact Graph calls without calling Graph', async () => {
    joiner = await c.hire({ legalFirstName: 'Zoë', legalLastName: "O'Fictional", jobTitle: 'Platform engineer', departmentId: engineering, startDate: addDays(day, 10) });
    joinerNumber = (await c.tx((t) => t.one<{ employee_number: string }>('SELECT employee_number FROM app.employees WHERE id = $1', [joiner]))).employee_number;
    mock.reset();
    const r = await c.api('GET', `/v1/integrations/it/microsoft365/preview/${joiner}?lifecycle=joiner`);
    expect(r.statusCode, r.body).toBe(200);
    preview = r.json();
    expect(mock.calls).toHaveLength(0);
    expect(preview.principalName).toBe('zoe.ofictional@fictional.example');
    expect(preview.operations).toEqual([
      {
        seq: 1,
        op: 'create_user',
        method: 'POST',
        url: 'https://graph.microsoft.com/v1.0/users',
        target: 'zoe.ofictional@fictional.example',
        body: { accountEnabled: true, displayName: "Zoë O'Fictional", givenName: 'Zoë', surname: "O'Fictional", mailNickname: 'zoe.ofictional', userPrincipalName: 'zoe.ofictional@fictional.example', employeeId: joinerNumber, jobTitle: 'Platform engineer', department: 'Engineering', usageLocation: 'GB', passwordProfile: { forceChangePasswordNextSignIn: true, password: '[generated at execution; never stored]' } },
      },
      { seq: 2, op: 'assign_licence', method: 'POST', url: 'https://graph.microsoft.com/v1.0/users/zoe.ofictional%40fictional.example/assignLicense', target: E3, body: { addLicenses: [{ skuId: E3, disabledPlans: [] }], removeLicenses: [] } },
      { seq: 3, op: 'add_group', method: 'POST', url: `https://graph.microsoft.com/v1.0/groups/${ALL_STAFF}/members/$ref`, target: ALL_STAFF, body: { '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/{userId}' } },
      { seq: 4, op: 'add_group', method: 'POST', url: `https://graph.microsoft.com/v1.0/groups/${ENG_GROUP}/members/$ref`, target: ENG_GROUP, body: { '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/{userId}' } },
    ]);
    const employee = await c.login(joiner);
    expect((await c.api('GET', `/v1/integrations/it/microsoft365/preview/${joiner}?lifecycle=joiner`, undefined, employee)).statusCode).toBe(403);
  });

  it('the hire event schedules the joiner job for the lead time before the start date; it runs exactly the previewed calls', async () => {
    mock.reset();
    await c.drain(); // events are processed; the job waits for its time
    expect(graphCalls()).toHaveLength(0);
    const job = await c.tx((t) => t.one<{ run_after: string; idempotency_key: string }>(`SELECT run_after, idempotency_key FROM app.jobs WHERE kind = 'it.lifecycle' AND input->>'employeeId' = $1 AND input->>'provider' = 'microsoft365'`, [joiner]));
    expect(new Date(job.run_after).getTime()).toBe(new Date(startOfDayInstant(addDays(day, 7), 'Europe/London')).getTime());
    expect(job.idempotency_key).toBe(`joiner:microsoft365:${joiner}:${addDays(day, 10)}`);
    await c.drain(new Date(new Date(job.run_after).getTime() + 60_000));
    const token = mock.calls.find((x) => x.url.startsWith('https://login.microsoftonline.com/'))!;
    expect(token.url).toBe(`https://login.microsoftonline.com/${ENTRA_TENANT}/oauth2/v2.0/token`);
    expect(token.form).toEqual({ client_id: APP_ID, client_secret: 'fictional-entra-secret', scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
    const sent = graphCalls();
    expect(sent.every((x) => x.headers.authorization === 'Bearer graph-token')).toBe(true);
    // exactly the dry-run plan, with only the generated password and the new account id filled in
    const password = (sent[0]!.json as { passwordProfile: { password: string } }).passwordProfile.password;
    expect(password).toMatch(/^[A-Za-z0-9_-]{24}[!#%+=?@]\dAa$/);
    const expected = preview.operations.map((o) => ({ method: o.method, url: o.url, body: JSON.parse(JSON.stringify(o.body ?? null).replace('[generated at execution; never stored]', password).replace('{userId}', 'aad-1')) }));
    expect(sent.map(requestOf)).toEqual(expected);
    // the password is never stored or audited
    const leaks = await c.tx((t) => t.query(`SELECT 1 FROM app.it_operations WHERE body::text LIKE $1 UNION ALL SELECT 1 FROM audit.events WHERE diff::text LIKE $1 UNION ALL SELECT 1 FROM app.jobs WHERE coalesce(result::text, '') LIKE $1`, [`%${password}%`]));
    expect(leaks).toHaveLength(0);
    const log = (await c.api('GET', `/v1/integrations/it/operations?employeeId=${joiner}&provider=microsoft365`)).json();
    expect(log.map((o: { op: string; status: string; responseStatus: number }) => [o.op, o.status, o.responseStatus])).toEqual([
      ['create_user', 'succeeded', 201],
      ['assign_licence', 'succeeded', 200],
      ['add_group', 'succeeded', 204],
      ['add_group', 'succeeded', 204],
    ]);
    const audit = await c.tx((t) => t.query<{ diff: { succeeded: number; principalName: string } }>(`SELECT diff FROM audit.events WHERE action = 'it.joiner_executed' AND target_id = $1`, [joiner]));
    expect(audit[0]!.diff).toMatchObject({ succeeded: 4, principalName: 'zoe.ofictional@fictional.example' });
  });

  it('re-running is idempotent: completed calls are never repeated', async () => {
    mock.reset();
    const run = await c.api('POST', `/v1/integrations/it/microsoft365/run/${joiner}`, { lifecycle: 'joiner' });
    expect(run.statusCode, run.body).toBe(200);
    await c.drain();
    expect(graphCalls()).toHaveLength(0);
    expect((await c.api('GET', `/v1/integrations/it/operations?employeeId=${joiner}&provider=microsoft365`)).json()).toHaveLength(4);
  });

  it('a transient failure stops the joiner chain; the retry only sends what is left', async () => {
    const other = await c.hire({ legalFirstName: 'Ray', legalLastName: 'Retry', startDate: addDays(day, 1), workEmail: 'ray.retry@fictional.example' });
    failGroupOnce = true;
    mock.reset();
    await c.drain(new Date(Date.now() + 2 * 86_400_000));
    const first = (await c.api('GET', `/v1/integrations/it/operations?employeeId=${other}&provider=microsoft365`)).json();
    expect(first.map((o: { op: string; status: string }) => `${o.op}:${o.status}`)).toEqual(['create_user:succeeded', 'assign_licence:succeeded', 'add_group:failed']);
    expect(graphCalls()[0]!.json).toMatchObject({ userPrincipalName: 'ray.retry@fictional.example' }); // the work email is the user principal name
    mock.reset();
    await c.api('POST', `/v1/integrations/it/microsoft365/run/${other}`, { lifecycle: 'joiner' });
    await c.drain();
    expect(graphCalls().map((x) => x.url)).toEqual([`https://graph.microsoft.com/v1.0/groups/${ALL_STAFF}/members/$ref`]);
    expect((graphCalls()[0]!.json as Record<string, string>)['@odata.id']).toBe('https://graph.microsoft.com/v1.0/directoryObjects/aad-2');
  });

  it('an existing account is adopted only when it carries the same employee number', async () => {
    graphUsers.set('pat.taken@fictional.example', { id: 'aad-legacy', employeeId: 'SOMEONE-ELSE' });
    const taken = await c.hire({ legalFirstName: 'Pat', legalLastName: 'Taken', startDate: addDays(day, 1) });
    await c.drain(new Date(Date.now() + 2 * 86_400_000));
    const ops = (await c.api('GET', `/v1/integrations/it/operations?employeeId=${taken}&provider=microsoft365`)).json();
    expect(ops[0]).toMatchObject({ op: 'create_user', status: 'failed' });
    expect(ops[0].error).toContain('principalNameTaken');
    expect(ops.slice(1).every((o: { status: string }) => o.status === 'skipped')).toBe(true);
    const mine = await c.hire({ legalFirstName: 'Max', legalLastName: 'Mine', startDate: addDays(day, 1) });
    const number = (await c.tx((t) => t.one<{ employee_number: string }>('SELECT employee_number FROM app.employees WHERE id = $1', [mine]))).employee_number;
    graphUsers.set('max.mine@fictional.example', { id: 'aad-adopted', employeeId: number });
    await c.drain(new Date(Date.now() + 2 * 86_400_000));
    const adopted = (await c.api('GET', `/v1/integrations/it/operations?employeeId=${mine}&provider=microsoft365`)).json();
    expect(adopted.every((o: { status: string }) => o.status === 'succeeded')).toBe(true);
  });

  it('hires backdated beyond the window (e.g. an import of current staff) are not provisioned automatically', async () => {
    const old = await c.hire({ legalFirstName: 'Olu', legalLastName: 'Old', startDate: addDays(day, -30) });
    await c.drain();
    expect(await c.tx((t) => t.query(`SELECT 1 FROM app.jobs WHERE kind = 'it.lifecycle' AND input->>'employeeId' = $1`, [old]))).toHaveLength(0);
  });
});

describe('Microsoft 365 leaver', () => {
  it('runs at the end of the last working day: blocks sign-in, revokes sessions and removes licences', async () => {
    const end = addDays(day, 20);
    expect((await c.api('POST', `/v1/employees/${joiner}/terminate`, { endDate: end, reason: 'Fictional resignation' })).statusCode).toBe(200);
    const plan = (await c.api('GET', `/v1/integrations/it/microsoft365/preview/${joiner}?lifecycle=leaver`)).json();
    mock.reset();
    await c.drain();
    expect(graphCalls()).toHaveLength(0);
    const job = await c.tx((t) => t.one<{ run_after: string }>(`SELECT run_after FROM app.jobs WHERE kind = 'it.lifecycle' AND idempotency_key = $1`, [`leaver:microsoft365:${joiner}:${end}`]));
    expect(new Date(job.run_after).getTime()).toBe(new Date(startOfDayInstant(addDays(end, 1), 'Europe/London')).getTime());
    await c.drain(new Date(new Date(job.run_after).getTime() + 60_000));
    const upn = 'https://graph.microsoft.com/v1.0/users/zoe.ofictional%40fictional.example';
    expect(graphCalls().map(requestOf)).toEqual([
      { method: 'PATCH', url: upn, body: { accountEnabled: false } },
      { method: 'POST', url: `${upn}/revokeSignInSessions`, body: null },
      { method: 'POST', url: `${upn}/assignLicense`, body: { addLicenses: [], removeLicenses: [E3] } },
    ]);
    expect(plan.operations.map((o: { method: string; url: string }) => `${o.method} ${o.url}`)).toEqual(graphCalls().map((x) => `${x.method} ${x.url}`));
    const account = await c.tx((t) => t.one<{ status: string; licences: unknown[] }>(`SELECT a.status, a.licences FROM app.it_accounts a JOIN app.it_connections c ON c.tenant_id = a.tenant_id AND c.id = a.connection_id WHERE c.provider = 'microsoft365' AND a.employee_id = $1`, [joiner]));
    expect(account).toEqual({ status: 'blocked', licences: [] });
  });

  it('a leaver with no known account is never matched to a generated name', async () => {
    const stranger = await c.hire({ legalFirstName: 'Noor', legalLastName: 'Known', startDate: '2020-01-06' });
    const plan = (await c.api('GET', `/v1/integrations/it/microsoft365/preview/${stranger}?lifecycle=leaver`)).json();
    expect(plan).toMatchObject({ operations: [], skipped: 'noKnownAccount' });
  });
});

describe('Google Workspace with domain-wide delegation', () => {
  it('verifies delegation with a signed JWT (RS256, admin subject, least-privilege scopes)', async () => {
    expect((await c.api('PUT', '/v1/integrations/it/google_workspace', { domain: 'fictional-g.example', directoryId: 'C01fict', adminSubject: 'it-admin@fictional-g.example', settings: { joinerLeadDays: 1, defaultOrgUnitPath: '/Staff' } })).statusCode).toBe(200);
    expect((await c.api('PUT', '/v1/integrations/it/google_workspace/credentials', { serviceAccountKey: '{"not":"a key"}' })).statusCode).toBe(400);
    expect((await c.api('PUT', '/v1/integrations/it/google_workspace/credentials', { serviceAccountKey: JSON.stringify(SERVICE_ACCOUNT) })).json()).toEqual({ configured: ['serviceAccountKey'] });
    expect((await c.api('POST', '/v1/integrations/it/google_workspace/consent')).json()).toEqual({
      url: null,
      clientId: SERVICE_ACCOUNT.client_id,
      scopes: ['https://www.googleapis.com/auth/admin.directory.user', 'https://www.googleapis.com/auth/admin.directory.user.security', 'https://www.googleapis.com/auth/admin.directory.group.member', 'https://www.googleapis.com/auth/apps.licensing'],
    });
    const v = await c.api('POST', '/v1/integrations/it/google_workspace/verify');
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().status).toBe('connected');
    expect(googleTokenClaims).toMatchObject({ alg: 'RS256', iss: SERVICE_ACCOUNT.client_email, sub: 'it-admin@fictional-g.example', aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/admin.directory.user https://www.googleapis.com/auth/admin.directory.user.security https://www.googleapis.com/auth/admin.directory.group.member https://www.googleapis.com/auth/apps.licensing' });
    expect((googleTokenClaims!.exp as number) - (googleTokenClaims!.iat as number)).toBe(3600);
    expect((await c.api('POST', '/v1/integrations/it/google_workspace/rules', { name: 'Everyone', match: {}, licences: [{ productId: 'Google-Apps', skuId: '1010020027' }], groups: ['staff@fictional-g.example'], orgUnitPath: '/Staff/UK' })).statusCode).toBe(201);
  });

  it('joiner and leaver use the Directory and Licensing API shapes', async () => {
    const g = await c.hire({ legalFirstName: 'Gia', legalLastName: 'Google', jobTitle: 'Designer', startDate: addDays(day, 5) });
    const number = (await c.tx((t) => t.one<{ employee_number: string }>('SELECT employee_number FROM app.employees WHERE id = $1', [g]))).employee_number;
    const plan = (await c.api('GET', `/v1/integrations/it/google_workspace/preview/${g}?lifecycle=joiner`)).json();
    mock.reset();
    await c.drain(new Date(Date.now() + 5 * 86_400_000));
    const sent = googleCalls();
    const password = (sent[0]!.json as { password: string }).password;
    expect(sent.map(requestOf)).toEqual([
      { method: 'POST', url: 'https://admin.googleapis.com/admin/directory/v1/users', body: { primaryEmail: 'gia.google@fictional-g.example', name: { givenName: 'Gia', familyName: 'Google' }, password, changePasswordAtNextLogin: true, orgUnitPath: '/Staff/UK', externalIds: [{ type: 'organization', value: number }], organizations: [{ primary: true, title: 'Designer' }] } },
      { method: 'POST', url: 'https://licensing.googleapis.com/apps/licensing/v1/product/Google-Apps/sku/1010020027/user', body: { userId: 'gia.google@fictional-g.example' } },
      { method: 'POST', url: 'https://admin.googleapis.com/admin/directory/v1/groups/staff%40fictional-g.example/members', body: { email: 'gia.google@fictional-g.example', role: 'MEMBER' } },
    ]);
    expect(plan.operations.map((o: { url: string }) => o.url)).toEqual(sent.map((x) => x.url));
    expect(sent.every((x) => x.headers.authorization === 'Bearer google-token')).toBe(true);
    const end = addDays(day, 30);
    await c.api('POST', `/v1/employees/${g}/terminate`, { endDate: end, reason: 'Fictional move' });
    mock.reset();
    await c.drain(new Date(new Date(startOfDayInstant(addDays(end, 1), 'Europe/London')).getTime() + 60_000));
    expect(googleCalls().map(requestOf)).toEqual([
      { method: 'PATCH', url: 'https://admin.googleapis.com/admin/directory/v1/users/gia.google%40fictional-g.example', body: { suspended: true } },
      { method: 'POST', url: 'https://admin.googleapis.com/admin/directory/v1/users/gia.google%40fictional-g.example/signOut', body: null },
      { method: 'DELETE', url: 'https://licensing.googleapis.com/apps/licensing/v1/product/Google-Apps/sku/1010020027/user/gia.google%40fictional-g.example', body: null },
    ]);
  });

  it('changing the directory or the admin requires consent again', async () => {
    const r = await c.api('PUT', '/v1/integrations/it/google_workspace', { domain: 'fictional-g.example', adminSubject: 'another-admin@fictional-g.example' });
    expect(r.json()).toMatchObject({ status: 'pending_consent', consentedAt: null });
    const audits = await c.tx((t) => t.query<{ action: string }>(`SELECT action FROM audit.events WHERE action LIKE 'it_connection.%' ORDER BY id`));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['it_connection.saved', 'it_connection.credentials_set', 'it_connection.consent_started', 'it_connection.consented', 'it_connection.verified']));
  });
});
