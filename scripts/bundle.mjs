// Bundles a service entry point into one ESM file. Workspace packages (@thapsus/*, TypeScript source)
// are bundled; every npm dependency stays external and is installed in the image by `pnpm deploy`.
import { build } from 'esbuild';
import { resolve } from 'node:path';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: bundle.mjs <entry.ts> <out.mjs>');
  process.exit(2);
}

await build({
  entryPoints: [resolve(entry)],
  outfile: resolve(outfile),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  plugins: [
    {
      name: 'externalise-npm',
      setup(b) {
        b.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, (args) => {
          if (args.path.startsWith('@thapsus/') || args.path.startsWith('node:')) return undefined;
          if (/^[a-zA-Z@]/.test(args.path)) return { path: args.path, external: true };
          return undefined;
        });
      },
    },
  ],
  loader: { '.json': 'json' },
});
console.log(`bundled ${entry} → ${outfile}`);
