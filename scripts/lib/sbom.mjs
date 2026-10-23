/**
 * Software bill of materials checks (ASVS V15.1.2, ADR-0135). Every third-party component must come
 * from the public npm registry with an integrity hash; only our own workspace packages (@thapsus/*
 * and the root) may have no download location.
 */
export const TRUSTED_REGISTRY = 'https://registry.npmjs.org/';

export function checkSbom(bom) {
  const problems = [];
  if (bom?.bomFormat !== 'CycloneDX') problems.push('not a CycloneDX document');
  const components = Array.isArray(bom?.components) ? bom.components : [];
  if (!components.length) problems.push('no components');
  for (const c of components) {
    const id = c.purl ?? `${c.group ? `${c.group}/` : ''}${c.name}@${c.version}`;
    const workspace = c.group === '@thapsus' || (c.purl ?? '').startsWith('pkg:npm/%40thapsus/');
    if (!c.version) problems.push(`${id}: no version`);
    if (workspace) continue;
    if (!(c.purl ?? '').startsWith('pkg:npm/')) problems.push(`${id}: not an npm package`);
    const dist = (c.externalReferences ?? []).filter((r) => r.type === 'distribution');
    if (!dist.length) problems.push(`${id}: no distribution location`);
    for (const r of dist) {
      if (!String(r.url ?? '').startsWith(TRUSTED_REGISTRY))
        problems.push(`${id}: from an untrusted location ${r.url}`);
      if (
        !(r.hashes ?? []).some(
          (h) => /^SHA-(256|384|512)$/.test(h.alg) && /^[0-9a-f]{64,128}$/.test(h.content),
        )
      )
        problems.push(`${id}: no integrity hash`);
    }
  }
  return { components: components.length, problems };
}
