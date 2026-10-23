import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import enGB from '../../packages/core/src/i18n/messages/en-GB.json';
import { analyseRoutes, covers, flattenKeys, providedBy } from '../lib/i18n-routes';
import { inNamespaces } from '../../apps/web/lib/i18n';

/**
 * Per-route catalogue scoping (ADR-0150). The root layout sends client components only the shared
 * namespaces; each route segment's layout adds what its pages use with `<Messages ns={[…]}>`. A key a
 * client component uses but no layout above it provides renders as the raw key, so this check walks
 * every page (and every layout's own client code) and fails on any such key.
 */
const root = join(__dirname, '..', '..');
const reports = analyseRoutes(root, enGB);
const leaves = flattenKeys(enGB);

describe('per-route message scoping', () => {
  it('finds the pages and their client code', () => {
    expect(reports.length).toBeGreaterThan(90);
    const assets = reports.find((r) => r.page === 'apps/web/app/app/assets/page.tsx')!;
    expect(assets.layouts).toEqual([
      'apps/web/app/layout.tsx',
      'apps/web/app/app/layout.tsx',
      'apps/web/app/app/assets/layout.tsx',
    ]);
    // the page itself, the shell (via the /app layout), the workspace map and the account menu it renders
    expect(assets.uses.map((u) => u.file)).toEqual(
      expect.arrayContaining([
        'apps/web/app/app/assets/page.tsx',
        'apps/web/app/app/shell.tsx',
        'apps/web/app/app/workspace.tsx',
        'apps/web/components/workspace/user-menu.tsx',
      ]),
    );
    // a template literal needs its whole static prefix
    expect(assets.uses.some((u) => u.key === 'assets.types')).toBe(true);
  });

  it('every message key client code uses on a route is provided by the layouts above that code', () => {
    const missing = reports.flatMap((r) =>
      r.missing.map(
        (m) =>
          `${r.page}: ${m.key} (used in ${m.file}${m.via === r.page ? '' : `, rendered by ${m.via}`}; provided: ${r.provided.join(', ')})`,
      ),
    );
    expect(
      missing,
      `Add the namespace to the nearest route layout's <Messages ns>:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('layouts name namespaces that exist in the catalogue', () => {
    const unknown: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const f = join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith('.tsx')) {
          for (const ns of providedBy(readFileSync(f, 'utf8'), f) ?? [])
            if (![...leaves].some((k) => inNamespaces(k, [ns]))) unknown.push(`${f}: ${ns}`);
        }
      }
    };
    walk(join(root, 'apps', 'web', 'app'));
    expect(unknown).toEqual([]);
  });

  it('the server and the check agree on what a namespace entry selects', () => {
    const sample = [
      'admin.saved',
      'admin.sso.title',
      'admin.sso.protocol.oidc',
      'common.save',
      'reports.col.status',
    ];
    for (const ns of ['admin', 'admin.*', 'admin.sso', 'admin.saved', 'common', 'reports.col']) {
      for (const k of sample.filter((k) => leaves.has(k)))
        expect(inNamespaces(k, [ns]), `${ns} ⊇ ${k}`).toBe(covers([ns], k, leaves));
    }
    expect(inNamespaces('admin.saved', ['admin.*'])).toBe(true);
    expect(inNamespaces('admin.sso.title', ['admin.*'])).toBe(false);
  });

  it('the root layout sends only shared namespaces, never the whole catalogue', () => {
    const rootLayout = readFileSync(join(root, 'apps/web/app/layout.tsx'), 'utf8');
    const shared = providedBy(rootLayout, 'apps/web/app/layout.tsx')!;
    const size = (ns: string[]) => [...leaves].filter((k) => inNamespaces(k, ns)).length;
    expect(size(shared)).toBeLessThan(leaves.size / 20);
    // client providers only ever get scoped messages, and the whole catalogue stays in the server helpers
    const files = execFileSync(
      'git',
      ['ls-files', '-co', '--exclude-standard', 'apps/web/app', 'apps/web/components', 'apps/web/lib'],
      { cwd: root, encoding: 'utf8' },
    )
      .split('\n')
      .filter((f) => /\.tsx?$/.test(f));
    const src = (f: string) => readFileSync(join(root, f), 'utf8');
    expect(files.filter((f) => /<I18nProvider\b/.test(src(f)))).toEqual(['apps/web/lib/i18n-scope.tsx']);
    expect(files.filter((f) => /\bmessagesFor\(/.test(src(f)))).toEqual([
      'apps/web/lib/i18n.ts',
      'apps/web/lib/server.ts',
    ]);
  });
});
