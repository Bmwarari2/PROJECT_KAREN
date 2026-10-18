import { describe, expect, it } from 'vitest';
import { planDeploy, PlanError } from '../deploy-plan';

describe('deploy planner', () => {
  it('a cell deploy: stack, internal token copy, VAPID + mock IdP keys (non-prod), migrator, restart, health', () => {
    const steps = planDeploy({ env: 'staging', only: 'cell-eu', awsRegion: 'eu-central-1', selfSignedTls: true });
    expect(steps.map((s) => s.kind)).toEqual(['cdk-deploy', 'sync-internal-token', 'ensure-vapid', 'ensure-mock-idp', 'run-migrator', 'restart-services', 'health-check']);
    expect(steps[0]).toMatchObject({ stack: 'ThapsusHr-staging-cell-eu', region: 'eu-central-1' });
    expect(steps[1]).toEqual({ kind: 'sync-internal-token', from: 'eu-west-2', fromSecret: 'thapsus-hr/staging/internal-token', to: 'eu-central-1', toSecret: 'thapsus-hr/staging/eu/internal-token' });
    expect(steps.at(-1)).toMatchObject({ kind: 'health-check', insecureTls: true });
  });

  it('production needs explicit approval and never gets a mock IdP', () => {
    expect(() => planDeploy({ env: 'prod', only: 'cell-uk', awsRegion: 'eu-west-2' })).toThrow(PlanError);
    const steps = planDeploy({ env: 'prod', only: 'cell-uk', awsRegion: 'eu-west-2', productionApproved: true });
    expect(steps.some((s) => s.kind === 'ensure-mock-idp')).toBe(false);
    expect(steps.find((s) => s.kind === 'health-check')).toMatchObject({ insecureTls: false });
  });

  it('backup copy vaults deploy only to the permitted backup regions, chosen by the credentials region', () => {
    expect(planDeploy({ env: 'staging', only: 'backupcopy', awsRegion: 'eu-west-1' })).toEqual([{ kind: 'cdk-deploy', stack: 'ThapsusHr-staging-backup-copy-eu', region: 'eu-west-1', parameters: {} }]);
    expect(planDeploy({ env: 'staging', only: 'backupcopy', awsRegion: 'us-west-1' })[0]).toMatchObject({ stack: 'ThapsusHr-staging-backup-copy-us' });
    // UK backups never leave London; no copy vault anywhere else
    expect(() => planDeploy({ env: 'staging', only: 'backupcopy', awsRegion: 'eu-west-2' })).toThrow(PlanError);
    expect(() => planDeploy({ env: 'staging', only: 'backupcopy', awsRegion: 'us-west-2' })).toThrow(PlanError);
    expect(() => planDeploy({ env: 'staging', only: 'backupcopy', awsRegion: 'us-east-1' })).toThrow(PlanError);
  });

  it('refuses credentials for the wrong region, unknown targets and unknown environments', () => {
    expect(() => planDeploy({ env: 'staging', only: 'cell-us', awsRegion: 'us-east-1' })).toThrow(/us-east-2/);
    expect(() => planDeploy({ env: 'staging', only: 'cell-xx' })).toThrow(PlanError);
    expect(() => planDeploy({ env: 'qa', only: 'global' })).toThrow(PlanError);
  });

  it('`all` runs in dependency order and never touches us-east-1 or us-west-2', () => {
    const steps = planDeploy({ env: 'staging', only: 'all' });
    const deploys = steps.filter((s) => s.kind === 'cdk-deploy');
    expect(deploys.map((s) => s.stack)).toEqual([
      'ThapsusHr-staging-ci',
      'ThapsusHr-staging-backup-copy-eu',
      'ThapsusHr-staging-backup-copy-us',
      'ThapsusHr-staging-global',
      'ThapsusHr-staging-cell-uk',
      'ThapsusHr-staging-cell-eu',
      'ThapsusHr-staging-cell-us',
    ]);
    const regions = new Set(steps.flatMap((s) => ('region' in s ? [s.region] : [s.from, s.to])));
    expect([...regions].sort()).toEqual(['eu-central-1', 'eu-west-1', 'eu-west-2', 'us-east-2', 'us-west-1']);
  });

  it('synthetic data only for load tests (or staging), in the cell region, never in production', () => {
    expect(planDeploy({ env: 'loadtest', only: 'synth-uk', awsRegion: 'eu-west-2' })).toEqual([{ kind: 'run-synth', stack: 'ThapsusHr-loadtest-cell-uk', region: 'eu-west-2', employees: 200_000, users: 26_000 }]);
    expect(() => planDeploy({ env: 'prod', only: 'synth-uk', awsRegion: 'eu-west-2', productionApproved: true })).toThrow(PlanError);
    expect(() => planDeploy({ env: 'loadtest', only: 'synth-uk', awsRegion: 'eu-central-1' })).toThrow(PlanError);
    // the load-test cell has no mock IdP
    expect(planDeploy({ env: 'loadtest', only: 'cell-uk', awsRegion: 'eu-west-2' }).some((s) => s.kind === 'ensure-mock-idp')).toBe(false);
  });
});
