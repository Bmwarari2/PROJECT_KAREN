import { App, Stack, Tags, type AppProps } from 'aws-cdk-lib';
import { HOME_REGIONS, REGIONS } from '@thapsus/core/regions';
import { BackupCopyVaultStack } from './backup-copy-vault-stack';
import { CellStack } from './cell-stack';
import { ENVS, FORBIDDEN_STACK_REGIONS, GLOBAL_REGION, loadConfig, names, type EnvName } from './config';
import { GlobalStack } from './global-stack';

/** Resource types whose CloudFormation schema has no Tags property (CDK would otherwise emit them). */
const UNTAGGABLE = ['AWS::RDS::DBProxyTargetGroup'];

function tag(stack: Stack, env: EnvName, cell: string) {
  for (const [k, v] of Object.entries({ project: 'thapsus-hr', env, cell })) Tags.of(stack).add(k, v, { excludeResourceTypes: UNTAGGABLE });
}

/** Adds every stack for one environment: global (eu-west-2), three cells, and the permitted copy vaults. */
export function addEnvironment(app: App, env: EnvName): Stack[] {
  const config = loadConfig(env);
  const stacks: Stack[] = [];
  const at = (region: string) => ({ account: config.account, region });

  const global = new GlobalStack(app, names.stack(env, 'global'), { env: at(GLOBAL_REGION), config, crossRegionReferences: false });
  tag(global, env, 'global');
  stacks.push(global);

  for (const cell of HOME_REGIONS) {
    const spec = REGIONS[cell];
    const stack = new CellStack(app, names.stack(env, `cell-${cell}`), { env: at(spec.awsRegion), config, cell, crossRegionReferences: false });
    tag(stack, env, cell);
    stacks.push(stack);
    if (spec.backupRegion) {
      const copy = new BackupCopyVaultStack(app, names.stack(env, `backup-copy-${cell}`), {
        env: at(spec.backupRegion),
        config,
        cell,
        crossRegionReferences: false,
      });
      tag(copy, env, cell);
      stacks.push(copy);
    }
  }
  for (const s of stacks) {
    if ((FORBIDDEN_STACK_REGIONS as readonly string[]).includes(s.region)) throw new Error(`${s.stackName}: region ${s.region} is denied by the org SCP`);
  }
  return stacks;
}

/** Builds the app. `-c env=staging` (or a comma-separated list) selects environments; default: all. */
export function buildApp(props?: AppProps): App {
  const app = new App(props);
  const selected = (app.node.tryGetContext('env') as string | undefined)?.split(',').map((s) => s.trim()) ?? [...ENVS];
  for (const env of selected) {
    if (!(ENVS as readonly string[]).includes(env)) throw new Error(`Unknown env "${env}" (expected ${ENVS.join(', ')})`);
    addEnvironment(app, env as EnvName);
  }
  return app;
}
