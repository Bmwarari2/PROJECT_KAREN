import { allowedAwsRegions, REGIONS, type HomeRegion } from './regions';

/**
 * Startup residency check for a cell: every configured endpoint that names an AWS region must be in
 * the cell's home region (backup resources may also use the permitted backup region). Services refuse
 * to start on any violation, so a UK cell can never be pointed at EU or US resources by configuration.
 */
export type ResourceKind = 'database' | 'objectStorage' | 'cache' | 'queue' | 'email' | 'logs' | 'kms' | 'backup' | 'search';

/** ElastiCache host names use short region codes. */
const SHORT_CODES: Record<string, string> = {
  euw1: 'eu-west-1',
  euw2: 'eu-west-2',
  euw3: 'eu-west-3',
  euc1: 'eu-central-1',
  eun1: 'eu-north-1',
  use1: 'us-east-1',
  use2: 'us-east-2',
  usw1: 'us-west-1',
  usw2: 'us-west-2',
};

/** Extracts the AWS region named by an ARN, URL, host name or region-suffixed bucket name. */
export function regionOf(resource: string): string | undefined {
  const arn = /^arn:aws[a-z-]*:[a-z0-9-]+:([a-z]{2}-[a-z]+-\d):/.exec(resource);
  if (arn) return arn[1];
  const long = /(?:^|[.\-/@])([a-z]{2}-(?:west|east|central|north|south|southeast|northeast)-\d)(?=[.\-/:]|$)/.exec(resource);
  if (long) return long[1];
  const short = /\.(euw\d|euc\d|eun\d|use\d|usw\d)\.cache\.amazonaws\.com/.exec(resource);
  if (short) return SHORT_CODES[short[1]!];
  return undefined;
}

export interface EndpointViolation {
  kind: ResourceKind;
  resource: string;
  region: string;
}

export function endpointViolations(cell: HomeRegion, endpoints: Array<{ kind: ResourceKind; resource: string }>): EndpointViolation[] {
  const out: EndpointViolation[] = [];
  for (const e of endpoints) {
    const region = regionOf(e.resource);
    if (!region) continue; // local emulators (localhost) carry no region
    const allowed = allowedAwsRegions(cell, e.kind === 'backup' ? 'backup' : 'runtime');
    if (!allowed.includes(region)) out.push({ kind: e.kind, resource: redactCredentials(e.resource), region });
  }
  return out;
}

const redactCredentials = (s: string) => s.replace(/\/\/[^@/]+@/, '//***@');

/** Collects every region-bearing endpoint from the environment. */
export function cellEndpointsFromEnv(env: NodeJS.ProcessEnv): Array<{ kind: ResourceKind; resource: string }> {
  const list: Array<{ kind: ResourceKind; resource: string }> = [];
  const add = (kind: ResourceKind, v: string | undefined) => v && list.push({ kind, resource: v });
  if (env.DATABASES) for (const url of Object.values(JSON.parse(env.DATABASES) as Record<string, string>)) add('database', url);
  add('database', env.DATABASE_URL);
  add('database', env.DATABASE_HOST);
  add('database', env.REPORTING_DATABASE_HOST);
  if (env.DEDICATED_DATABASE_HOSTS) for (const h of Object.values(JSON.parse(env.DEDICATED_DATABASE_HOSTS) as Record<string, string>)) add('database', h);
  add('database', env.REPORTING_DATABASE_URL);
  // Read replicas used for reports and data exports (shared and dedicated databases).
  if (env.READER_DATABASES) for (const url of Object.values(JSON.parse(env.READER_DATABASES) as Record<string, string>)) add('database', url);
  if (env.DEDICATED_READER_HOSTS) for (const h of Object.values(JSON.parse(env.DEDICATED_READER_HOSTS) as Record<string, string>)) add('database', h);
  add('database', env.BACKOFFICE_DATABASE_URL);
  add('cache', env.VALKEY_URL);
  add('objectStorage', env.FILES_BUCKET);
  add('objectStorage', env.S3_ENDPOINT);
  add('kms', env.KMS_KEY_ARN);
  add('kms', env.FILES_KMS_KEY_ARN);
  for (const k of Object.keys(env).filter((k) => k.startsWith('QUEUE_URL_'))) add('queue', env[k]);
  add('queue', env.EVENT_BUS_ARN);
  add('email', env.SES_IDENTITY_ARN);
  add('email', env.SES_REGION);
  add('logs', env.LOG_GROUP_ARN);
  add('backup', env.BACKUP_VAULT_ARN);
  add('backup', env.BACKUP_COPY_VAULT_ARN);
  return list;
}

export function assertCellResidency(cell: HomeRegion, env: NodeJS.ProcessEnv = process.env) {
  const v = endpointViolations(cell, cellEndpointsFromEnv(env));
  if (v.length) {
    throw new Error(
      `Residency violation for ${cell} cell (${REGIONS[cell].awsRegion}): ` + v.map((x) => `${x.kind} in ${x.region}`).join(', '),
    );
  }
}
