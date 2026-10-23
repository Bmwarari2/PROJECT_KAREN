/**
 * Data-residency map. This is the ONLY place region codes and backup targets are defined, for AWS and for
 * Google Cloud (ADR-0001, ADR-0156). Enforced by test/core.test.ts and the residency test matrix.
 */
export const HOME_REGIONS = ['uk', 'eu', 'us'] as const;
export type HomeRegion = (typeof HOME_REGIONS)[number];

export interface RegionSpec {
  /** Short code stored on the tenant (tenant directory + regional registry). */
  code: HomeRegion;
  /** AWS region holding all personal data, files, logs, caches, queues and email for the tenant. */
  awsRegion: string;
  /** Only region a backup copy may be written to, or null when backups must stay in the home region. */
  backupRegion: string | null;
  /** Google Cloud region holding the cell's data where the cell runs on Google Cloud (staging, ADR-0156). */
  gcpRegion: string;
  /** Only Google Cloud region a backup copy may be written to (same jurisdiction), or null. */
  gcpBackupRegion: string | null;
  /** Legal regime used for data-subject-request deadlines, breach clocks etc. */
  jurisdiction: 'UK' | 'EU' | 'US';
  /** BCP-47 default locale and ISO 4217 default currency for new tenants in the region. */
  defaultLocale: 'en-GB' | 'en-US';
  defaultCurrency: 'GBP' | 'EUR' | 'USD';
  defaultTimeZone: string;
}

export const REGIONS: Readonly<Record<HomeRegion, RegionSpec>> = Object.freeze({
  uk: {
    code: 'uk',
    awsRegion: 'eu-west-2',
    backupRegion: null,
    gcpRegion: 'europe-west2',
    gcpBackupRegion: null,
    jurisdiction: 'UK',
    defaultLocale: 'en-GB',
    defaultCurrency: 'GBP',
    defaultTimeZone: 'Europe/London',
  },
  eu: {
    code: 'eu',
    awsRegion: 'eu-central-1',
    backupRegion: 'eu-west-1',
    gcpRegion: 'europe-west3',
    gcpBackupRegion: 'europe-west1',
    jurisdiction: 'EU',
    defaultLocale: 'en-GB',
    defaultCurrency: 'EUR',
    defaultTimeZone: 'Europe/Berlin',
  },
  us: {
    code: 'us',
    awsRegion: 'us-east-2',
    backupRegion: 'us-west-1',
    gcpRegion: 'us-east5',
    gcpBackupRegion: 'us-west1',
    jurisdiction: 'US',
    defaultLocale: 'en-US',
    defaultCurrency: 'USD',
    defaultTimeZone: 'America/New_York',
  },
});

export function isHomeRegion(value: unknown): value is HomeRegion {
  return typeof value === 'string' && (HOME_REGIONS as readonly string[]).includes(value);
}

export function regionSpec(code: HomeRegion): RegionSpec {
  return REGIONS[code];
}

export function homeRegionForAwsRegion(awsRegion: string): HomeRegion | undefined {
  return HOME_REGIONS.find((c) => REGIONS[c].awsRegion === awsRegion);
}

/** AWS regions a given cell may touch for a purpose. Backup tooling may additionally reach the backup region. */
export function allowedAwsRegions(code: HomeRegion, purpose: 'runtime' | 'backup'): string[] {
  const spec = REGIONS[code];
  if (purpose === 'backup' && spec.backupRegion) return [spec.awsRegion, spec.backupRegion];
  return [spec.awsRegion];
}

export function homeRegionForGcpRegion(gcpRegion: string): HomeRegion | undefined {
  return HOME_REGIONS.find((c) => REGIONS[c].gcpRegion === gcpRegion);
}

/**
 * Google Cloud locations a given cell may touch for a purpose: only single regions, never a multi-region or
 * dual-region. Backup tooling may additionally reach the backup region.
 */
export function allowedGcpLocations(code: HomeRegion, purpose: 'runtime' | 'backup'): string[] {
  const spec = REGIONS[code];
  if (purpose === 'backup' && spec.gcpBackupRegion) return [spec.gcpRegion, spec.gcpBackupRegion];
  return [spec.gcpRegion];
}

/** Every ordered pair of distinct home regions, used by the residency test matrix. */
export function regionPairs(): Array<[HomeRegion, HomeRegion]> {
  const pairs: Array<[HomeRegion, HomeRegion]> = [];
  for (const a of HOME_REGIONS) for (const b of HOME_REGIONS) if (a !== b) pairs.push([a, b]);
  return pairs;
}
