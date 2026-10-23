// Run inside a built API or worker image: every package the bundles in /srv/dist import must
// resolve from there. `pnpm deploy` once nested workspace packages' dependencies where the bundles
// could not find them, so the services would not start.
//   docker run --rm -i --entrypoint node <image> --input-type=module - < scripts/check-image-imports.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const dir = '/srv/dist';
const bundles = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
const specs = new Set();
const PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.@-]+)*$/;
for (const f of bundles) {
  const src = readFileSync(`${dir}/${f}`, 'utf8');
  const patterns = [
    /^import\s[^;]*?\bfrom\s*"([^"]+)";/gm, // static imports (esbuild prints one per line)
    /^import\s*"([^"]+)";/gm,
    /\bimport\(\s*"([^"]+)"\s*\)/g, // dynamic imports
    /\b__require\(\s*"([^"]+)"\s*\)/g, // require() of an external inside bundled CommonJS
  ];
  for (const re of patterns)
    for (const m of src.matchAll(re)) if (PACKAGE.test(m[1]) && !m[1].startsWith('node:')) specs.add(m[1]);
}
const require = createRequire(`${dir}/index.js`);
const missing = [];
for (const s of [...specs].sort()) {
  try {
    import.meta.resolve(s, `file://${dir}/index.mjs`);
  } catch {
    try {
      require.resolve(s);
    } catch {
      missing.push(s);
    }
  }
}
console.log(`${bundles.length} bundles, ${specs.size} packages imported, ${missing.length} missing`);
if (missing.length) {
  console.log(missing.join('\n'));
  process.exit(1);
}
