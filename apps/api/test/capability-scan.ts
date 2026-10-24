import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * Static scans for the permission map tests (ADR-0188), with the TypeScript compiler's parser:
 *  - webActionCalls: every state-changing API call the signed-in app makes (`api(path, { method })` or
 *    `fetch(path, { method })`), with the capability it declares and the capabilities the file checks;
 *  - routeBlocks: every API route registered with a capability, with the permission strings its handler
 *    passes to a check.
 */
export const REPO = join(import.meta.dirname, '..', '..', '..');
const WEB = join(REPO, 'apps', 'web');
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
};

const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const literals = (e: ts.Expression): string[] | null => {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  // `/v1/x/${id}/y` → `/v1/x/:p/y` (a placeholder for each substitution)
  if (ts.isTemplateExpression(e))
    return [e.head.text + e.templateSpans.map((s) => `:p${s.literal.text}`).join('')];
  if (ts.isConditionalExpression(e)) {
    const a = literals(e.whenTrue);
    const b = literals(e.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isParenthesizedExpression(e)) return literals(e.expression);
  return null;
};

export interface WebActionCall {
  /** Repo-relative file. */
  file: string;
  line: number;
  method: string;
  /** Paths with `:p` placeholders and no query string; null when the path is not written at the call. */
  paths: string[] | null;
  /** The `capability` the call declares, or null. */
  capability: string | null;
  /** The page whose directory holds the file (`/app/settings/branding`), if any. */
  page: string | null;
  /** Capability keys the file checks: can('…'), useCan('…'), allows(…, '…'). */
  checked: Set<string>;
}

/** The page route of the nearest directory with a page.tsx, for files under apps/web/app/app. */
function pageOf(file: string): string | null {
  const appDir = join(WEB, 'app');
  if (!file.startsWith(join(appDir, 'app') + sep) && file !== join(appDir, 'app')) return null;
  let dir = dirname(file);
  while (dir.startsWith(join(appDir, 'app'))) {
    if (existsSync(join(dir, 'page.tsx')))
      return (
        '/' +
        relative(appDir, dir)
          .split(sep)
          .filter((s) => s && !/^\(.*\)$/.test(s))
          .join('/')
      );
    dir = dirname(dir);
  }
  return null;
}

/** The signed-in app's own files (not the marketing site, sign-in pages, kiosk or back office). */
export function webAppFiles(): string[] {
  return [
    ...walk(join(WEB, 'app', 'app')),
    ...walk(join(WEB, 'components')),
    ...walk(join(WEB, 'lib')).filter((f) => !f.endsWith(`${sep}proxy.ts`)),
  ];
}

export function webActionCalls(files = webAppFiles()): WebActionCall[] {
  const out: WebActionCall[] = [];
  for (const file of files) {
    const src = parse(file);
    const checked = new Set<string>();
    const calls: Omit<WebActionCall, 'checked'>[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(src);
        if (/(^|\.)(can|useCan|allows)$/.test(callee))
          for (const a of n.arguments) if (ts.isStringLiteral(a)) checked.add(a.text);
        const [first, init] = n.arguments;
        if (first && init && ts.isObjectLiteralExpression(init)) {
          const prop = (name: string) =>
            init.properties.find(
              (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(src) === name,
            );
          const method = prop('method');
          const methods = method ? literals(method.initializer) : null;
          if (methods?.some((m) => MUTATING.has(m))) {
            const cap = prop('capability');
            const paths = literals(first);
            for (const m of methods.filter((x) => MUTATING.has(x)))
              calls.push({
                file: relative(REPO, file),
                line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1,
                method: m,
                paths: paths?.map((p) => p.split('?')[0]!) ?? null,
                capability: cap && ts.isStringLiteral(cap.initializer) ? cap.initializer.text : null,
                page: pageOf(file),
              });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    for (const c of calls)
      if (c.paths?.every((p) => p.startsWith('/v1/')) ?? true) out.push({ ...c, checked });
  }
  return out;
}

export interface RouteRef {
  method: string;
  /** OpenAPI path (`/v1/x/{id}`). */
  path: string;
}

/**
 * The routes a call can reach: a placeholder matches any segment, a written segment must match the
 * route's own (or a parameter there). The most specific routes win (most written segments equal).
 */
export function routesFor(method: string, path: string, routes: RouteRef[]): RouteRef[] {
  const want = path.split('/').filter(Boolean);
  let best: RouteRef[] = [];
  let bestScore = -1;
  for (const r of routes) {
    if (r.method !== method.toLowerCase()) continue;
    const have = r.path.split('/').filter(Boolean);
    if (have.length !== want.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < have.length; i++) {
      const param = /^\{.+\}$/.test(have[i]!);
      const placeholder = want[i]!.startsWith(':p');
      if (placeholder) continue;
      if (param) continue;
      if (have[i] !== want[i]) {
        ok = false;
        break;
      }
      score++;
    }
    if (!ok) continue;
    if (score > bestScore) [best, bestScore] = [[r], score];
    else if (score === bestScore) best.push(r);
  }
  return best;
}

export interface RouteBlock {
  file: string;
  line: number;
  method: string;
  url: string;
  capability: string;
  /** Permission strings passed to a check in the route's handler (authorize, can, need…). */
  checks: string[];
  /** Of those, the ones checked without a record to scope them (company-wide: authorize(req, p), can(principal, p)). */
  workspaceChecks: string[];
}

const PERMISSION = /^[a-z_]+\.[a-z_*]+(?::[a-z_*]+)?$/;
const CHECK_CALL = /(^|\.)(authorize|authorizeSome|can|canSome|need|canAsset|allowed|guard|scopePredicate)$/;

/** Routes registered with `config.capability` in apps/api/src/modules, and the permissions each checks. */
export function routeBlocks(): RouteBlock[] {
  const out: RouteBlock[] = [];
  for (const file of walk(join(REPO, 'apps', 'api', 'src', 'modules'))) {
    const src = parse(file);
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ['get', 'post', 'put', 'patch', 'delete'].includes(n.expression.name.text) &&
        n.arguments.length >= 3 &&
        ts.isObjectLiteralExpression(n.arguments[1]!)
      ) {
        const opts = n.arguments[1] as ts.ObjectLiteralExpression;
        const config = opts.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(src) === 'config',
        );
        const cap =
          config && ts.isObjectLiteralExpression(config.initializer)
            ? config.initializer.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && p.name.getText(src) === 'capability',
              )
            : undefined;
        if (cap && ts.isStringLiteral(cap.initializer)) {
          const checks = new Set<string>();
          const workspaceChecks = new Set<string>();
          const scan = (x: ts.Node) => {
            if (ts.isCallExpression(x) && CHECK_CALL.test(x.expression.getText(src))) {
              for (const a of x.arguments)
                if (ts.isStringLiteral(a) && PERMISSION.test(a.text)) checks.add(a.text);
              const callee = x.expression.getText(src);
              const second = x.arguments[1];
              if (
                /(^|\.)(authorize|can)$/.test(callee) &&
                x.arguments.length === 2 &&
                second &&
                ts.isStringLiteral(second) &&
                PERMISSION.test(second.text)
              )
                workspaceChecks.add(second.text);
            }
            ts.forEachChild(x, scan);
          };
          for (const a of n.arguments.slice(2)) scan(a);
          const url = n.arguments[0]!;
          out.push({
            file: relative(REPO, file),
            line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1,
            method: n.expression.name.text.toUpperCase(),
            url: ts.isStringLiteral(url) ? url.text : url.getText(src),
            capability: cap.initializer.text,
            checks: [...checks],
            workspaceChecks: [...workspaceChecks],
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return out;
}

export interface CheckLiteral {
  file: string;
  line: number;
  callee: string;
  value: string;
}

/** Every string literal passed to a permission check (authorize, can, need…) anywhere in the API's source. */
export function checkCallLiterals(): CheckLiteral[] {
  const out: CheckLiteral[] = [];
  for (const file of walk(join(REPO, 'apps', 'api', 'src'))) {
    const src = parse(file);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(src);
        if (CHECK_CALL.test(callee))
          for (const a of n.arguments)
            if (ts.isStringLiteral(a))
              out.push({
                file: relative(REPO, file),
                line: src.getLineAndCharacterOfPosition(a.getStart(src)).line + 1,
                callee,
                value: a.text,
              });
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return out;
}
