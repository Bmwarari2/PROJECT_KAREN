import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Type, type TSchema } from 'typebox';
import { cleanBody } from '../src/http/validation';
import { closeDb, ownerSession, startTestApp, type TestContext } from './helpers';

/**
 * ASVS V15.3.3 mass assignment: no route can receive a request-body field its schema does not declare.
 * Every route's body schema is enumerated from the running app (including hidden routes).
 */
let ctx: TestContext;
let seen: Record<string, unknown> | undefined;
beforeAll(async () => {
  ctx = await startTestApp({
    listen: false,
    extend: (app) => {
      app.post(
        '/v1/test-only/echo',
        {
          schema: {
            hide: true,
            body: Type.Object({
              name: Type.String(),
              nested: Type.Optional(Type.Object({ keep: Type.String() })),
              map: Type.Optional(Type.Record(Type.String(), Type.String())),
            }),
          },
        },
        async (req) => {
          seen = req.body as Record<string, unknown>;
          return { ok: true };
        },
      );
    },
  });
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

/** The object variants a body may take (top-level object, union of objects, intersection, array of objects). */
function variants(schema: TSchema): TSchema[] {
  const s = schema as TSchema & { anyOf?: TSchema[]; type?: string; items?: TSchema };
  if (s.anyOf) return s.anyOf.flatMap(variants);
  if (s.type === 'array' && s.items) return variants(s.items);
  return [schema];
}
const probe = '__massAssignmentProbe';

describe('mass assignment (ASVS V15.3.3)', () => {
  it('every route body removes or refuses a field it does not declare', () => {
    const bodies = ctx.app.routeBodies;
    expect(bodies.length).toBeGreaterThan(150);
    const leaks: string[] = [];
    for (const { method, url, schema } of bodies) {
      for (const v of variants(schema)) {
        const closed = (v as { additionalProperties?: unknown }).additionalProperties === false;
        const out = cleanBody(v, {
          [probe]: 'injected',
          isAdmin: true,
          tenantId: '00000000-0000-4000-8000-000000000000',
        }) as Record<string, unknown>;
        const declared = Object.keys((v as { properties?: Record<string, unknown> }).properties ?? {});
        const kept = [probe, ...['isAdmin', 'tenantId'].filter((k) => !declared.includes(k))].filter(
          (k) => out && typeof out === 'object' && k in out,
        );
        if (!closed && kept.length) leaks.push(`${method} ${url}: ${kept.join(', ')}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('a handler never sees undeclared fields, at any depth; declared maps keep their keys', async () => {
    const owner = await ownerSession(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/test-only/echo',
      headers: { cookie: owner.cookie },
      payload: {
        name: 'Fictional',
        role: 'owner',
        tenantId: 'someone-else',
        nested: { keep: 'yes', isAdmin: true },
        map: { a: '1', b: '2' },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(seen).toEqual({ name: 'Fictional', nested: { keep: 'yes' }, map: { a: '1', b: '2' } });
  });

  it('closed schemas still refuse unknown fields outright', async () => {
    const owner = await ownerSession(ctx);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/v1/settings/security',
      headers: { cookie: owner.cookie },
      payload: { sessionIdleMinutes: 30, bypassMfa: true },
    });
    expect(res.statusCode).toBe(400);
  });
});
