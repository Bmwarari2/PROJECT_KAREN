import { beforeAll, describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  implies,
  isCapabilityKey,
  pageFor,
  type CapabilityKey,
} from '@thapsus/core/capabilities';
import { buildSpec } from '../src/openapi';
import { routesFor, webActionCalls, type RouteRef, type WebActionCall } from './capability-scan';

/**
 * The permission map between the app and the API (PROGRESS 16.1, ADR-0188). Every state-changing call
 * the signed-in app makes declares the capability of the UI action behind it; the route it calls
 * declares its own (`config.capability`, published as `x-capability`). A UI action may never need less
 * than its route: whoever the app shows the action to must also pass the route's permission check.
 */
type Op = { 'x-capability'?: string; 'x-permission'?: { any: string[]; all: string[] } };
let ops: Map<string, Op>;
let routes: RouteRef[];
let calls: WebActionCall[];

beforeAll(async () => {
  const spec = (await buildSpec()) as { paths: Record<string, Record<string, Op>> };
  ops = new Map();
  routes = [];
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, op] of Object.entries(item)) {
      ops.set(`${method} ${path}`, op);
      routes.push({ method, path });
    }
  calls = webActionCalls();
}, 120_000);

const where = (c: WebActionCall) => `${c.file}:${c.line} ${c.method} ${c.paths?.join(' | ') ?? '(path not written at the call)'}`;
const routeCapability = (r: RouteRef) => ops.get(`${r.method} ${r.path}`)?.['x-capability'];

describe('UI actions and the API routes they call (ADR-0188)', () => {
  it('finds the app’s state-changing calls', () => {
    expect(calls.length).toBeGreaterThan(150);
  });

  it('every route that declares a capability names one in the map, with its permissions published', () => {
    const declared = [...ops].filter(([, op]) => op['x-capability']);
    expect(declared.length).toBeGreaterThan(150);
    for (const [key, op] of declared) {
      expect(isCapabilityKey(op['x-capability']), key).toBe(true);
      const req = CAPABILITIES[op['x-capability'] as CapabilityKey];
      expect(op['x-permission'], key).toEqual({ any: req.any ?? [], all: req.all ?? [] });
    }
  });

  it('every state-changing call names its path, declares a capability in the map and reaches a route that declares one', () => {
    const problems: string[] = [];
    for (const c of calls) {
      if (!c.paths) problems.push(`${where(c)}: write the path at the call so the route can be found`);
      if (!c.capability) problems.push(`${where(c)}: declare the UI action's capability ({ capability: '…' })`);
      else if (!isCapabilityKey(c.capability)) problems.push(`${where(c)}: unknown capability ${c.capability}`);
      for (const path of c.paths ?? []) {
        const found = routesFor(c.method, path, routes);
        if (!found.length) problems.push(`${where(c)}: no ${c.method} route matches ${path}`);
        for (const r of found)
          if (!routeCapability(r))
            problems.push(`${where(c)}: ${r.method.toUpperCase()} ${r.path} declares no capability (config.capability)`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("no UI action needs less than the API route it calls (a test fails when the two differ)", () => {
    const problems: string[] = [];
    for (const c of calls) {
      if (!c.capability || !isCapabilityKey(c.capability)) continue;
      for (const path of c.paths ?? [])
        for (const r of routesFor(c.method, path, routes)) {
          const rc = routeCapability(r);
          if (rc && isCapabilityKey(rc) && !implies(c.capability, rc))
            problems.push(
              `${where(c)}: the action needs ${c.capability} (${JSON.stringify(CAPABILITIES[c.capability])}) but ${r.method.toUpperCase()} ${r.path} needs ${rc} (${JSON.stringify(CAPABILITIES[rc])})`,
            );
        }
    }
    expect(problems).toEqual([]);
  });

  it('each action is shown only to people with its capability: the file checks it, or its page or everyone has it', () => {
    const problems: string[] = [];
    for (const c of calls) {
      if (!c.capability || !isCapabilityKey(c.capability)) continue;
      const req = CAPABILITIES[c.capability];
      if (!req.any?.length && !req.all?.length) continue; // everyone signed in
      if (c.checked.has(c.capability)) continue;
      const page = c.page ? pageFor(c.page) : undefined;
      if (page && implies(page.view, c.capability)) continue;
      problems.push(
        `${where(c)}: gate the control with can('${c.capability}') (its page ${c.page ?? '(none)'} opens for ${page?.view ?? 'anyone'})`,
      );
    }
    expect(problems).toEqual([]);
  });

  it('would catch Settings → Branding again: the page opens with settings.read, saving needs settings.manage', () => {
    const save = routesFor('PUT', '/v1/settings/branding', routes);
    expect(save).toEqual([{ method: 'put', path: '/v1/settings/branding' }]);
    const rc = routeCapability(save[0]!) as CapabilityKey;
    expect(CAPABILITIES[rc].any).toEqual(['settings.manage']);
    // the page's own capability (what an HR admin holds) does not cover the save route…
    expect(pageFor('/app/settings/branding')?.view).toBe('settings.branding');
    expect(implies('settings.branding', rc)).toBe(false);
    // …so the save button is gated by the manage capability, which does
    expect(pageFor('/app/settings/branding')?.manage).toBe('settings.branding.manage');
    expect(implies('settings.branding.manage', rc)).toBe(true);
    const branding = calls.filter((c) => c.file.endsWith('settings/branding/page.tsx'));
    expect(branding.length).toBeGreaterThan(0);
    for (const c of branding) expect(c.capability, where(c)).toBe('settings.branding.manage');
  });
});
