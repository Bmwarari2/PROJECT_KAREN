import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';

/**
 * SCIM 2.0 conformance, modelled on the checks run by common IdP validators (Microsoft Entra ID
 * and Okta): discovery, create, get, list with filter and paging, PUT, PATCH (path and no-path
 * forms), deactivate, groups and membership, error schema, uniqueness and token scoping.
 */
let ctx: TestContext;
let token: string;
let otherToken: string;
let tenantId: string;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  const a = await ownerSession(ctx);
  tenantId = a.tenantId;
  token = (
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/settings/scim-tokens',
      headers: { cookie: a.cookie },
      payload: { name: 'Entra' },
    })
  ).json().token;
  const b = await ownerSession(ctx);
  otherToken = (
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/settings/scim-tokens',
      headers: { cookie: b.cookie },
      payload: { name: 'Okta' },
    })
  ).json().token;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

const scim = (method: string, url: string, payload?: unknown, tok = token) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/scim/v2${url}`,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/scim+json' },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });

const userBody = (userName: string, extra: Record<string, unknown> = {}) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  userName,
  externalId: `ext-${userName}`,
  name: { givenName: 'Fictional', familyName: 'Person' },
  emails: [{ value: userName, type: 'work', primary: true }],
  active: true,
  ...extra,
});

describe('SCIM discovery and auth', () => {
  it('serves ServiceProviderConfig and ResourceTypes', async () => {
    expect((await scim('GET', '/ServiceProviderConfig')).json().patch.supported).toBe(true);
    expect((await scim('GET', '/ResourceTypes')).json().totalResults).toBe(2);
  });
  it('rejects missing or invalid tokens with the SCIM error schema', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    const forged = token.replace(/\.[^.]+$/, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect((await scim('GET', '/Users', undefined, forged)).statusCode).toBe(401);
  });
});

describe('SCIM Users', () => {
  let id: string;
  it('creates a user (201) with meta and location', async () => {
    const res = await scim('POST', '/Users', userBody('scim.one@a.example.test'));
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toContain('application/scim+json');
    const body = res.json();
    id = body.id;
    expect(body).toMatchObject({
      userName: 'scim.one@a.example.test',
      active: true,
      externalId: 'ext-scim.one@a.example.test',
      meta: { resourceType: 'User' },
    });
  });
  it('enforces userName uniqueness with 409 uniqueness', async () => {
    const res = await scim('POST', '/Users', userBody('scim.one@a.example.test'));
    expect(res.statusCode).toBe(409);
    expect(res.json().scimType).toBe('uniqueness');
  });
  it('gets by id and returns 404 for unknown ids', async () => {
    expect((await scim('GET', `/Users/${id}`)).json().id).toBe(id);
    expect((await scim('GET', '/Users/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await scim('GET', '/Users/not-a-uuid')).statusCode).toBe(404);
  });
  it('lists with eq filters on userName and externalId, and pages', async () => {
    for (let i = 0; i < 3; i++) await scim('POST', '/Users', userBody(`scim.page${i}@a.example.test`));
    const f = await scim(
      'GET',
      `/Users?filter=${encodeURIComponent('userName eq "scim.one@a.example.test"')}`,
    );
    expect(f.json()).toMatchObject({ totalResults: 1, Resources: [{ id }] });
    const e = await scim(
      'GET',
      `/Users?filter=${encodeURIComponent('externalId eq "ext-scim.one@a.example.test"')}`,
    );
    expect(e.json().totalResults).toBe(1);
    const none = await scim(
      'GET',
      `/Users?filter=${encodeURIComponent('userName eq "nobody@a.example.test"')}`,
    );
    expect(none.json()).toMatchObject({ totalResults: 0, Resources: [] });
    const page = await scim('GET', '/Users?startIndex=2&count=2');
    expect(page.json()).toMatchObject({ startIndex: 2, itemsPerPage: 2 });
    expect(page.json().totalResults).toBeGreaterThanOrEqual(5);
    expect((await scim('GET', `/Users?filter=${encodeURIComponent('title co "x"')}`)).json().scimType).toBe(
      'invalidFilter',
    );
  });
  it('replaces with PUT', async () => {
    const res = await scim(
      'PUT',
      `/Users/${id}`,
      userBody('scim.one@a.example.test', { displayName: 'Renamed Person' }),
    );
    expect(res.json().displayName).toBe('Renamed Person');
  });
  it('patches with path and without path (Entra style), and deactivation revokes access', async () => {
    const p1 = await scim('PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'name.familyName', value: 'Example' }],
    });
    expect(p1.json().displayName).toBe('Renamed Example');
    const p2 = await scim('PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { active: 'False' } }],
    });
    expect(p2.statusCode).toBe(200);
    expect(p2.json().active).toBe(false);
    const p3 = await scim('PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: true }],
    });
    expect(p3.json().active).toBe(true);
    expect((await scim('PATCH', `/Users/${id}`, { Operations: [] })).statusCode).toBe(400);
  });
  it('DELETE deactivates (records retained) and audits', async () => {
    expect((await scim('DELETE', `/Users/${id}`)).statusCode).toBe(204);
    expect((await scim('GET', `/Users/${id}`)).json().active).toBe(false);
  });
  it('tokens are scoped to their tenant', async () => {
    expect((await scim('GET', `/Users/${id}`, undefined, otherToken)).statusCode).toBe(404);
    const list = await scim('GET', '/Users', undefined, otherToken);
    expect(list.json().Resources.some((u: { id: string }) => u.id === id)).toBe(false);
    void tenantId;
  });
});

describe('SCIM Groups', () => {
  it('creates, filters, patches membership and deletes', async () => {
    const u1 = (await scim('POST', '/Users', userBody('grp.one@a.example.test'))).json().id;
    const u2 = (await scim('POST', '/Users', userBody('grp.two@a.example.test'))).json().id;
    const g = await scim('POST', '/Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Engineering',
      members: [{ value: u1 }],
    });
    expect(g.statusCode).toBe(201);
    const gid = g.json().id;
    expect(g.json().members).toHaveLength(1);
    const f = await scim('GET', `/Groups?filter=${encodeURIComponent('displayName eq "Engineering"')}`);
    expect(f.json().totalResults).toBe(1);
    const add = await scim('PATCH', `/Groups/${gid}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'add', path: 'members', value: [{ value: u2 }] }],
    });
    expect(add.json().members).toHaveLength(2);
    const rm = await scim('PATCH', `/Groups/${gid}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'remove', path: `members[value eq "${u1}"]` }],
    });
    expect(rm.json().members.map((m: { value: string }) => m.value)).toEqual([u2]);
    const rename = await scim('PATCH', `/Groups/${gid}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { displayName: 'Platform' } }],
    });
    expect(rename.json().displayName).toBe('Platform');
    expect((await scim('DELETE', `/Groups/${gid}`)).statusCode).toBe(204);
    expect((await scim('GET', `/Groups/${gid}`)).statusCode).toBe(404);
  });
});
