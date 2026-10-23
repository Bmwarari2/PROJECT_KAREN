import { HOME_REGIONS, REGIONS, type HomeRegion } from '../packages/core/src/regions';
import { dedicatedDatabasesFor, ENVS, FORBIDDEN_STACK_REGIONS, GLOBAL_REGION, loadConfig, names, type EnvConfig, type EnvName } from '../infra/lib/config';

/**
 * Pure deployment planner used by scripts/deploy.mjs (and unit-tested). It turns
 * `--env <env> --only <target>` into an ordered list of steps. It never talks to AWS itself.
 *
 * Targets: `ci`, `backupcopy` (the copy vault for the current AWS region), `global`, `cell-uk`,
 * `cell-eu`, `cell-us`, or `all` (in dependency order).
 */
export type Target = 'ci' | 'backupcopy' | 'global' | `cell-${HomeRegion}` | `synth-${HomeRegion}` | 'all';

export type Step =
  | { kind: 'cdk-deploy'; stack: string; region: string; parameters: Record<string, string> }
  | { kind: 'sync-internal-token'; from: string; fromSecret: string; to: string; toSecret: string }
  | { kind: 'ensure-vapid'; region: string; secretName: string }
  | { kind: 'ensure-mock-idp'; region: string; secretName: string }
  /** Migrates one database of the cell: `shared` (the migrator task) or a dedicated database (its tools task). */
  | { kind: 'run-migrator'; stack: string; region: string; database: string; taskDefinitionOutput: string }
  | { kind: 'run-synth'; stack: string; region: string; employees: number; users: number }
  | { kind: 'restart-services'; stack: string; region: string }
  | { kind: 'health-check'; stack: string; region: string; insecureTls: boolean };

export interface PlanInput {
  env: string;
  only: string;
  /** AWS region the credentials are for (AWS_REGION); required for `backupcopy` and checked for others. */
  awsRegion?: string;
  /** Production needs an explicit approval (the GitHub `production` environment gate, or a human flag). */
  productionApproved?: boolean;
  /** CloudFormation parameters (e.g. CertificateArn, GlobalBaseUrl) per stack kind. */
  parameters?: Partial<Record<'global' | `cell-${HomeRegion}`, Record<string, string>>>;
  /** Staging without a domain uses an imported self-signed certificate; health checks accept it explicitly. */
  selfSignedTls?: boolean;
  /** `synth-<cell>`: size of the synthetic enterprise tenant to generate (load tests). */
  synth?: { employees: number; users: number };
  /** The environment config (tests); default: infra/config/<env>.json. Supplies the dedicated databases. */
  config?: EnvConfig;
}

export class PlanError extends Error {}

const ORDER: Target[] = ['ci', 'backupcopy', 'global', 'cell-uk', 'cell-eu', 'cell-us'];

export function planDeploy(input: PlanInput): Step[] {
  if (!(ENVS as readonly string[]).includes(input.env)) throw new PlanError(`unknown env "${input.env}" (expected ${ENVS.join(', ')})`);
  const env = input.env as EnvName;
  if (env === 'prod' && !input.productionApproved) throw new PlanError('production deploys need explicit approval (GitHub "production" environment or --approved)');
  if (input.only === 'all') {
    // `all` runs locally with one set of credentials per region; each target re-checks its own region.
    return ORDER.flatMap((t) =>
      t === 'backupcopy'
        ? HOME_REGIONS.filter((c) => REGIONS[c].backupRegion).flatMap((c) => planTarget(env, 'backupcopy', { ...input, awsRegion: REGIONS[c].backupRegion! }))
        : planTarget(env, t, { ...input, awsRegion: regionOf(t) }),
    );
  }
  const synth = /^synth-(uk|eu|us)$/.exec(input.only);
  if (synth) return planSynth(env, synth[1] as HomeRegion, input);
  if (!(ORDER as string[]).includes(input.only)) throw new PlanError(`unknown target "${input.only}" (expected ${[...ORDER, 'synth-<cell>', 'all'].join(', ')})`);
  return planTarget(env, input.only as Target, input);
}

function regionOf(t: Target): string | undefined {
  if (t === 'ci' || t === 'global') return GLOBAL_REGION;
  if (t.startsWith('cell-')) return REGIONS[t.slice(5) as HomeRegion].awsRegion;
  return undefined;
}

function guardRegion(region: string) {
  if ((FORBIDDEN_STACK_REGIONS as readonly string[]).includes(region)) throw new PlanError(`region ${region} is denied by the organisation SCP (ADR-0001)`);
}

function planTarget(env: EnvName, t: Target, input: PlanInput): Step[] {
  if (t === 'backupcopy') {
    const cell = HOME_REGIONS.find((c) => REGIONS[c].backupRegion === input.awsRegion);
    if (!input.awsRegion || !cell) throw new PlanError(`backupcopy needs AWS_REGION set to a permitted backup region (${HOME_REGIONS.map((c) => REGIONS[c].backupRegion).filter(Boolean).join(', ')})`);
    guardRegion(input.awsRegion);
    return [{ kind: 'cdk-deploy', stack: names.stack(env, `backup-copy-${cell}`), region: input.awsRegion, parameters: {} }];
  }
  const region = regionOf(t)!;
  guardRegion(region);
  if (input.awsRegion && input.awsRegion !== region) throw new PlanError(`${t} deploys to ${region} but the credentials are for ${input.awsRegion}`);
  const stack = names.stack(env, t);
  const params = (t === 'ci' ? {} : input.parameters?.[t]) ?? {};
  const deploy: Step = { kind: 'cdk-deploy', stack, region, parameters: params };
  if (t === 'ci') return [deploy];
  if (t === 'global') return [deploy, { kind: 'health-check', stack, region, insecureTls: !!input.selfSignedTls }];
  const steps: Step[] = [
    deploy,
    { kind: 'sync-internal-token', from: GLOBAL_REGION, fromSecret: names.internalTokenSecret(env), to: region, toSecret: names.cellInternalTokenSecret(env, t.slice(5) as HomeRegion) },
    { kind: 'ensure-vapid', region, secretName: `thapsus-hr/${env}/vapid` },
  ];
  // The mock IdP only exists in dev and staging (for the SSO smoke tests).
  if (env === 'dev' || env === 'staging') steps.push({ kind: 'ensure-mock-idp', region, secretName: `thapsus-hr/${env}/mock-idp` });
  // Every database of the cell is migrated before the services restart: the shared one, then each dedicated
  // database (ADR-0068) through its tools task, so a tenant on a dedicated database never lags a release.
  const cell = t.slice(5) as HomeRegion;
  steps.push({ kind: 'run-migrator', stack, region, database: 'shared', taskDefinitionOutput: 'MigratorTaskDefinitionArn' });
  for (const d of dedicatedDatabasesFor(input.config ?? loadConfig(env), cell)) {
    steps.push({ kind: 'run-migrator', stack, region, database: d.key, taskDefinitionOutput: names.dedicatedOutputs(d.key).toolsTaskDefinitionArn });
  }
  steps.push({ kind: 'restart-services', stack, region }, { kind: 'health-check', stack, region, insecureTls: !!input.selfSignedTls });
  return steps;
}

/** Generates the synthetic enterprise tenant inside a cell (load tests only; never in production). */
function planSynth(env: EnvName, cell: HomeRegion, input: PlanInput): Step[] {
  if (env !== 'loadtest' && env !== 'staging') throw new PlanError('synthetic data is generated only in the loadtest (or staging) environment');
  const region = REGIONS[cell].awsRegion;
  if (input.awsRegion && input.awsRegion !== region) throw new PlanError(`synth-${cell} runs in ${region} but the credentials are for ${input.awsRegion}`);
  const { employees, users } = input.synth ?? { employees: 200_000, users: 26_000 };
  return [{ kind: 'run-synth', stack: names.stack(env, `cell-${cell}`), region, employees, users }];
}
