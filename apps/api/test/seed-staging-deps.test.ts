import { describe, expect, it } from 'vitest';
import { GcsObjectStore } from '../src/lib/object-store';
import { StagingConfigError } from '../src/cli/staging/config';
import { stagingDepsFromEnv } from '../src/cli/staging/deps';

/**
 * The staging seed job's dependencies (ADR-0185). The job is given the seed's secrets only, not the API's: a
 * reset once failed on staging because it built the API's dependencies, which need INTERNAL_TOKEN.
 */
const jobEnv = {
  // the seed job's environment in infra/gcp/staging/run.tf (common_env), without a directory database
  APP_ENV: 'staging',
  CELL_REGION: 'uk',
  SERVICE_ROLE: 'cell',
  DATABASE_URL: 'postgres://thapsus_app:unused@127.0.0.1:1/thapsus',
  GCP_KMS_KEY: 'projects/thapsus-hr-staging/locations/europe-west2/keyRings/thapsus/cryptoKeys/fields',
  GCS_FILES_BUCKET: 'thapsus-hr-staging-thapsus-stg-uk-files',
  MAIL_TRANSPORT: 'bucket',
  MAIL_BUCKET: 'thapsus-hr-staging-thapsus-stg-uk-mail',
};

describe('staging seed job dependencies', () => {
  it('build from the seed job environment without the API secrets (no INTERNAL_TOKEN)', async () => {
    expect(jobEnv).not.toHaveProperty('INTERNAL_TOKEN');
    const { seed, purge } = await stagingDepsFromEnv('staging', jobEnv);
    expect(seed.objects).toBeInstanceOf(GcsObjectStore);
    // the reset and the seed that follows it use the same database router, directory and file store
    expect(purge.router).toBe(seed.router);
    expect(purge.directory).toBe(seed.directory);
    expect(purge.objects).toBe(seed.objects);
    expect(purge.config.env).toBe('staging');
  });

  it('refuses an unknown APP_ENV, so the deletion certificate never has an undefined retention', async () => {
    await expect(stagingDepsFromEnv('stagin', jobEnv)).rejects.toBeInstanceOf(StagingConfigError);
  });
});
