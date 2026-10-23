import { ResidencyViolationError } from './aws';
import { allowedGcpLocations, type HomeRegion } from './regions';

/**
 * Residency guard for Google Cloud (ADR-0156). Google Cloud resources name their location in different
 * ways; this reads each of them so a cell can refuse anything outside its own region:
 *  - resource names: `projects/<p>/locations/<location>/…` (Cloud KMS keys, most other APIs);
 *  - Cloud SQL connection names `<project>:<region>:<instance>` (a domain-scoped project adds a prefix) and the
 *    `/cloudsql/<connection name>` socket directory Cloud Run mounts, also inside a database URL;
 *  - Cloud Storage bucket locations as the API reports them (`EUROPE-WEST2`, or `EU` / `NAM4` for multi-regions
 *    and dual-regions, which every cell refuses because they keep copies outside the home region).
 * Region codes themselves live only in regions.ts.
 */

/** A single Google Cloud region, e.g. europe-west2 or us-east5. */
const SINGLE_REGION = /^[a-z]+-[a-z]+\d+$/;
/** Cloud Storage multi-regions (EU, US, ASIA) and predefined dual-regions (EUR4, NAM4, ASIA1, …). */
const MULTI_OR_DUAL_REGION = /^(?:eu|us|asia|[a-z]{3,4}\d+)$/;
const RESOURCE_NAME = /(?:^|\/)projects\/[^/]+\/locations\/([^/?#&\s]+)/;
const SOCKET_DIR = /\/cloudsql\/([^/?#&\s]+)/;
const CONNECTION_NAME = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]*:([a-z]+-[a-z]+\d+):[a-z][a-z0-9-]*$/;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The Google Cloud location a resource names (lower case), or undefined when it names none. */
export function gcpLocationOf(resource: string): string | undefined {
  const text = decode(resource.trim());
  const named = RESOURCE_NAME.exec(text);
  if (named) return named[1]!.toLowerCase();
  const socket = SOCKET_DIR.exec(text);
  if (socket) {
    const parts = socket[1]!.split(':');
    // <project>:<region>:<instance>, or <domain>:<project>:<region>:<instance>
    if (parts.length >= 3) return parts[parts.length - 2]!.toLowerCase();
  }
  const lower = text.toLowerCase();
  const conn = CONNECTION_NAME.exec(lower);
  if (conn) return conn[1];
  if (SINGLE_REGION.test(lower) || MULTI_OR_DUAL_REGION.test(lower)) return lower;
  return undefined;
}

/** True for a single region (never a multi-region, dual-region or `global`). */
export function isGcpRegion(location: string): boolean {
  return SINGLE_REGION.test(location.toLowerCase());
}

export class GcpResidencyViolationError extends ResidencyViolationError {
  constructor(location: string, cell: HomeRegion, purpose: 'runtime' | 'backup') {
    super(location, cell, purpose);
    this.name = 'GcpResidencyViolationError';
    const why = !location
      ? 'an unknown location'
      : isGcpRegion(location)
        ? location
        : `${location} (multi-region or dual-region locations are never allowed)`;
    this.message = `Residency guard: cell "${cell}" may not use a ${purpose} Google Cloud resource in ${why}`;
  }
}

/** Throws unless the location is one the cell may use for the purpose. An unknown location is refused. */
export function assertGcpLocationAllowed(
  cell: HomeRegion,
  location: string | undefined,
  purpose: 'runtime' | 'backup' = 'runtime',
): void {
  const loc = (location ?? '').trim().toLowerCase();
  if (!loc || !allowedGcpLocations(cell, purpose).includes(loc))
    throw new GcpResidencyViolationError(loc, cell, purpose);
}

/** Throws unless the resource names a location the cell may use; a resource that names no location is refused. */
export function assertGcpResourceAllowed(
  cell: HomeRegion,
  resource: string,
  purpose: 'runtime' | 'backup' = 'runtime',
): void {
  assertGcpLocationAllowed(cell, gcpLocationOf(resource), purpose);
}
