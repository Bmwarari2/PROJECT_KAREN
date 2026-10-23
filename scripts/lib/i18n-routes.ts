import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { pluralBase } from '../../packages/core/src/i18n/format';

/**
 * Static analysis of which message keys each web route needs on the client (ADR-0150).
 *
 * Client components read messages from the `I18nProvider` context, which holds only the namespaces
 * the route's layouts provide (`<Messages ns={[…]}>`). For every page this walks the module graph of
 * the page and of each layout above it, symbol by symbol (an import of `useSession` from the shell
 * brings in `useSession` and what it references, not the whole shell), marks the client side of it
 * ('use client' modules and everything they import) and collects the message keys that code mentions:
 * string literals that are catalogue keys or key prefixes, and the static heads of template literals
 * (`privacy.ui.tab.${key}` needs `privacy.ui.tab`). Server components translate with the full
 * catalogue and need nothing from the provider. Keys that only arrive at run time (report column
 * labels from the API) are not visible here; the layouts of those routes provide their namespaces.
 */
export interface KeyUse {
  /** a full key or a key prefix (`reports.exports.error` for `reports.exports.error.${code}`) */
  key: string;
  file: string;
}
export interface RouteReport {
  /** page file relative to the repo root */
  page: string;
  /** layouts from the root down to the page */
  layouts: string[];
  /** namespaces the page sees (all its layouts) */
  provided: string[];
  uses: KeyUse[];
  /** keys used where the layouts above that code do not provide them */
  missing: Array<KeyUse & { via: string }>;
}

const SPECIAL = ['layout.tsx', 'template.tsx', 'loading.tsx', 'error.tsx', 'not-found.tsx'];
/** Calls whose string argument names a permission, not a message (`has('reports.run')`). */
const PERMISSION_CALLS = new Set(['has', 'hasPermission', 'can']);
const toPosix = (p: string) => p.split(sep).join('/');

/** Every message key, with plural forms (`org.reports_one`, `org.reports_other`) counted as their base key (`org.reports`). */
export function flattenKeys(o: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (o && typeof o === 'object')
    for (const [k, v] of Object.entries(o)) flattenKeys(v, prefix ? `${prefix}.${k}` : k, out);
  else out.add(pluralBase(prefix));
  return out;
}

/** All keys plus every dotted prefix of a key ('a.b.c' gives 'a', 'a.b' and 'a.b.c'). */
function keyPrefixes(keys: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    const parts = k.split('.');
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('.'));
  }
  return out;
}

export const isClientModule = (src: string) =>
  /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/.test(src);

/**
 * Whether a key (or key prefix) is among the provided namespaces. `ns` provides every key under it;
 * `ns.*` provides only the messages directly in `ns`, not its groups (`admin.*` gives `admin.saved`
 * but not `admin.sso.title`). `leaves` is the set of full keys in the catalogue.
 */
export const covers = (provided: readonly string[], key: string, leaves: ReadonlySet<string>) =>
  provided.some((p) =>
    p.endsWith('.*')
      ? key.startsWith(p.slice(0, -1)) && !key.slice(p.length - 1).includes('.') && leaves.has(key)
      : key === p || key.startsWith(`${p}.`),
  );

/** The namespaces a layout adds with `<Messages ns={['a', 'b.c']}>`; null when it renders no `<Messages>`. */
export function providedBy(src: string, file: string): string[] | null {
  if (!/<Messages\b/.test(src)) return null;
  const m = /<Messages\b[^>]*?\bns=\{\[([^\]]*)\]\}/.exec(src);
  if (!m)
    throw new Error(
      `${file}: <Messages> must list its namespaces inline as ns={['…']} so the scope check can read them`,
    );
  return m[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const lit = /^(['"])([\w-]+(?:\.[\w-]+)*(?:\.\*)?)\1$/.exec(s);
      if (!lit) throw new Error(`${file}: <Messages ns> entries must be string literals, got ${s}`);
      return lit[2]!;
    });
}

interface Lit {
  text: string;
  templateHead: boolean;
}
/** A top-level statement: the names it declares, the literals in it and the identifiers it mentions. */
interface Unit {
  names: string[];
  literals: Lit[];
  refs: Set<string>;
  /** statements that are not declarations run when the module loads */
  always: boolean;
}
interface ModuleInfo {
  client: boolean;
  units: Unit[];
  /** local name → module specifier and imported name ('default', a name, or '*' for a namespace import) */
  imports: Map<string, { spec: string; name: string }>;
  /** `import './x'` */
  bare: string[];
  /** exported name → local name (`export { a as b }`) */
  localExports: Map<string, string>;
  /** `export { a as b } from './x'` and `export * from './x'` */
  reexports: Array<{ spec: string; names: Map<string, string> | '*' }>;
}

function literalsIn(node: ts.Node, out: Lit[], refs: Set<string>) {
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const p = n.parent;
      const permission =
        ts.isCallExpression(p) && ts.isIdentifier(p.expression) && PERMISSION_CALLS.has(p.expression.text);
      if (!permission) out.push({ text: n.text, templateHead: false });
    } else if (ts.isTemplateExpression(n)) out.push({ text: n.head.text, templateHead: true });
    else if (ts.isIdentifier(n)) refs.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
}

const bindingNames = (n: ts.BindingName, out: string[] = []): string[] => {
  if (ts.isIdentifier(n)) out.push(n.text);
  else for (const e of n.elements) if (!ts.isOmittedExpression(e)) bindingNames(e.name, out);
  return out;
};

function moduleInfo(file: string, src: string): ModuleInfo {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const info: ModuleInfo = {
    client: isClientModule(src),
    units: [],
    imports: new Map(),
    bare: [],
    localExports: new Map(),
    reexports: [],
  };
  const isDefault = (n: ts.Node) =>
    ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      const c = st.importClause;
      if (!c) info.bare.push(spec);
      else if (!c.isTypeOnly) {
        if (c.name) info.imports.set(c.name.text, { spec, name: 'default' });
        const b = c.namedBindings;
        if (b && ts.isNamespaceImport(b)) info.imports.set(b.name.text, { spec, name: '*' });
        else if (b)
          for (const e of b.elements)
            if (!e.isTypeOnly) info.imports.set(e.name.text, { spec, name: (e.propertyName ?? e.name).text });
      }
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      const elements =
        st.exportClause && ts.isNamedExports(st.exportClause)
          ? st.exportClause.elements.filter((e) => !e.isTypeOnly)
          : null;
      if (st.moduleSpecifier) {
        const spec = (st.moduleSpecifier as ts.StringLiteral).text;
        info.reexports.push({
          spec,
          names: elements
            ? new Map(elements.map((e) => [e.name.text, (e.propertyName ?? e.name).text]))
            : '*',
        });
      } else if (elements)
        for (const e of elements) info.localExports.set(e.name.text, (e.propertyName ?? e.name).text);
      continue;
    }
    const unit: Unit = { names: [], literals: [], refs: new Set(), always: false };
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) {
      if (st.name) unit.names.push(st.name.text);
      if (isDefault(st)) unit.names.push('default');
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) bindingNames(d.name, unit.names);
    } else if (ts.isExportAssignment(st)) unit.names.push('default');
    else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st))
      continue; // types carry no runtime code
    else unit.always = true;
    literalsIn(st, unit.literals, unit.refs);
    info.units.push(unit);
  }
  return info;
}

export function analyseRoutes(root: string, catalogue: unknown): RouteReport[] {
  const web = join(root, 'apps', 'web');
  const appDir = join(web, 'app');
  const leaves = flattenKeys(catalogue);
  const prefixes = keyPrefixes(leaves);
  const infos = new Map<string, ModuleInfo>();
  const info = (f: string) => {
    let i = infos.get(f);
    if (!i) infos.set(f, (i = moduleInfo(f, readFileSync(f, 'utf8'))));
    return i;
  };
  const resolve = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith('@/')) base = join(web, spec.slice(2));
    else if (spec.startsWith('.')) base = join(dirname(from), spec);
    else return null; // packages: their components take translated strings as props
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')])
      if (/\.tsx?$/.test(c) && existsSync(c) && statSync(c).isFile()) return c;
    return null;
  };
  const keysOf = (lits: Lit[], file: string): KeyUse[] => {
    const out: KeyUse[] = [];
    for (const { text, templateHead } of lits) {
      if (templateHead) {
        const m = /^([a-zA-Z][\w-]*(?:\.[\w-]+)*)\.$/.exec(text);
        if (m && prefixes.has(m[1]!)) out.push({ key: m[1]!, file });
      } else if (/^[a-zA-Z][\w-]*(?:\.[\w-]+)+$/.test(text) && prefixes.has(text))
        out.push({ key: text, file });
    }
    return out;
  };

  /** Message keys in the client code reachable from `entry`'s default export. */
  const clientKeys = (entry: string): KeyUse[] => {
    const out: KeyUse[] = [];
    const done = new Set<string>();
    const included = new Set<string>();
    const work: Array<{ file: string; name: string; fromClient: boolean }> = [
      { file: entry, name: 'default', fromClient: false },
    ];
    const follow = (from: string, spec: string, name: string, client: boolean) => {
      const target = resolve(from, spec);
      if (target) work.push({ file: target, name, fromClient: client });
    };
    while (work.length) {
      const { file, name, fromClient } = work.pop()!;
      const mod = info(file);
      const client = fromClient || mod.client;
      const id = `${client ? 'c' : 's'}|${file}`;
      if (done.has(`${id}|${name}`)) continue;
      done.add(`${id}|${name}`);
      const rel = toPosix(relative(root, file));
      const include = (u: Unit, i: number) => {
        if (included.has(`${id}|${i}`)) return;
        included.add(`${id}|${i}`);
        if (client) out.push(...keysOf(u.literals, rel));
        for (const r of u.refs) {
          mod.units.forEach((v, j) => v.names.includes(r) && include(v, j));
          const imp = mod.imports.get(r);
          if (imp) follow(file, imp.spec, imp.name, client);
        }
      };
      mod.units.forEach((u, i) => u.always && include(u, i));
      for (const spec of mod.bare) follow(file, spec, '*', client);
      const wanted = name === '*' ? null : (mod.localExports.get(name) ?? name);
      mod.units.forEach((u, i) => (wanted === null || u.names.includes(wanted)) && include(u, i));
      if (wanted !== null) {
        const imp = mod.imports.get(wanted); // `import { x } …; export { x }`
        if (imp && mod.localExports.has(name)) follow(file, imp.spec, imp.name, client);
      } else for (const imp of mod.imports.values()) follow(file, imp.spec, imp.name, client);
      for (const re of mod.reexports) {
        if (re.names === '*') follow(file, re.spec, name, client);
        else if (name === '*') for (const n of re.names.values()) follow(file, re.spec, n, client);
        else if (re.names.has(name)) follow(file, re.spec, re.names.get(name)!, client);
      }
    }
    return out;
  };

  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name === 'page.tsx') pages.push(join(dir, e.name));
    }
  };
  walk(appDir);

  const uniq = <T extends KeyUse>(xs: T[]) => [...new Map(xs.map((x) => [`${x.key}|${x.file}`, x])).values()];
  return pages.sort().map((page) => {
    const segments: string[] = [];
    for (let d = dirname(page); ; d = dirname(d)) {
      segments.unshift(d);
      if (d === appDir) break;
    }
    const provided: string[] = [];
    const layouts: string[] = [];
    const uses: KeyUse[] = [];
    const missing: Array<KeyUse & { via: string }> = [];
    const check = (entry: string, scope: readonly string[]) => {
      for (const u of clientKeys(entry)) {
        uses.push(u);
        if (!covers(scope, u.key, leaves)) missing.push({ ...u, via: toPosix(relative(root, entry)) });
      }
    };
    for (const seg of segments) {
      const layout = join(seg, 'layout.tsx');
      if (existsSync(layout)) {
        layouts.push(toPosix(relative(root, layout)));
        provided.push(...(providedBy(readFileSync(layout, 'utf8'), toPosix(relative(root, layout))) ?? []));
      }
      // a layout's own client code sees what it and the layouts above it provide
      for (const special of SPECIAL)
        if (existsSync(join(seg, special))) check(join(seg, special), [...provided]);
    }
    check(page, provided);
    return {
      page: toPosix(relative(root, page)),
      layouts,
      provided,
      uses: uniq(uses),
      missing: uniq(missing),
    };
  });
}
