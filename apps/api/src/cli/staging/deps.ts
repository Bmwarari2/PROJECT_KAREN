import type { CellConfig } from '@thapsus/core/config';
import { TenantRouter } from '@thapsus/db';
import { directoryFromEnv } from '../../lib/directory';
import { keyProviderFromEnv } from '../../lib/kms';
import { mailerFromEnv } from '../../lib/mailer';
import { objectStoreFromEnv } from '../../lib/object-store';
import { rateLimiterFromEnv } from '../../lib/rate-limit';
import type { PurgeDeps } from '../../modules/privacy/company';
import { StagingConfigError } from './config';
import type { StagingSeedDeps } from './seed';

const APP_ENVS: readonly string[] = ['dev', 'test', 'staging', 'loadtest'];

/**
 * The staging seed job's dependencies, from its own environment: the seed's stores, and the purge's for a
 * reset (ADR-0185). Not the API's `depsFromEnv`, which also needs the API's secrets (the internal token
 * among them) that the seed job is not given, and should not be.
 */
export async function stagingDepsFromEnv(
  appEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ seed: StagingSeedDeps; purge: PurgeDeps }> {
  if (!APP_ENVS.includes(appEnv)) throw new StagingConfigError(`Invalid APP_ENV ${appEnv}`);
  const router = TenantRouter.fromEnv(env);
  const directory = await directoryFromEnv(env);
  const objects = objectStoreFromEnv('uk', env);
  return {
    seed: { router, directory, keys: keyProviderFromEnv('uk', env), objects },
    purge: {
      router,
      directory,
      objects,
      limiter: rateLimiterFromEnv(env),
      mailer: mailerFromEnv('uk', env),
      now: () => new Date(),
      config: { env: appEnv as CellConfig['env'] },
    },
  };
}
