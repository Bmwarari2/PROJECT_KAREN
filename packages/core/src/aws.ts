import { allowedAwsRegions, type HomeRegion } from './regions';

export class ResidencyViolationError extends Error {
  constructor(
    readonly requestedRegion: string,
    readonly cell: HomeRegion,
    readonly purpose: string,
  ) {
    super(`Residency guard: cell "${cell}" may not create a ${purpose} AWS client in ${requestedRegion}`);
    this.name = 'ResidencyViolationError';
  }
}

export interface AwsClientOptions {
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: unknown;
  [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientCtor<C> = new (config: any) => C;

export interface GuardedFactoryOptions {
  cell: HomeRegion;
  /** Local emulator endpoints keyed by service name (dev/test only). */
  endpoints?: Partial<Record<string, string>>;
}

/**
 * The only sanctioned way to build AWS SDK clients. It refuses any region other than the cell's
 * home region, or the permitted backup region when purpose === 'backup'.
 */
export function createAwsClientFactory(opts: GuardedFactoryOptions) {
  return function create<C>(
    Ctor: ClientCtor<C>,
    service: string,
    config: AwsClientOptions = {},
    purpose: 'runtime' | 'backup' = 'runtime',
  ): C {
    const allowed = allowedAwsRegions(opts.cell, purpose);
    const region = config.region ?? allowed[0]!;
    assertRegionAllowed(opts.cell, region, purpose);
    const endpoint = config.endpoint ?? opts.endpoints?.[service];
    return new Ctor({
      ...config,
      region,
      ...(endpoint ? { endpoint, forcePathStyle: service === 's3' ? true : config.forcePathStyle } : {}),
    });
  };
}

export function assertRegionAllowed(cell: HomeRegion, region: string, purpose: 'runtime' | 'backup' = 'runtime') {
  if (!allowedAwsRegions(cell, purpose).includes(region)) {
    throw new ResidencyViolationError(region, cell, purpose);
  }
}

/** Throws if an ARN or URL names a region outside the cell's allowed set. */
export function assertResourceInRegion(cell: HomeRegion, resource: string, purpose: 'runtime' | 'backup' = 'runtime') {
  const arn = /^arn:aws[a-z-]*:[a-z0-9-]+:([a-z0-9-]*):/.exec(resource);
  const host = /([a-z]{2}-[a-z]+-\d)\.amazonaws\.com/.exec(resource);
  const region = arn?.[1] || host?.[1];
  if (region) assertRegionAllowed(cell, region, purpose);
}
