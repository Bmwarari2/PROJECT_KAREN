// Deploys Thapsus-HR stacks for one environment. Run with tsx so it can share the region map:
//   node --import tsx scripts/deploy.mjs --env staging --only cell-uk [--dry-run] [--approved]
//     [--param CertificateArn=arn:...] [--param GlobalBaseUrl=https://...] [--self-signed-tls]
// Targets: ci | backupcopy | global | cell-uk | cell-eu | cell-us | all (in dependency order);
// synth-<cell> [--employees N --users N] generates the synthetic tenant (loadtest/staging only).
// Production refuses to run without --approved (or the GitHub "production" environment, which
// sets DEPLOY_ENVIRONMENT=production after its manual approval gate).
// Credentials: GitHub OIDC in CI (no keys in the repo); locally, an SSO/assumed-role session.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { get } from 'node:https';
import { planDeploy, PlanError } from './deploy-plan.ts';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const pair = (kv) => kv.split(/=(.*)/s).slice(0, 2);
const params = Object.fromEntries([
  ...(process.env.DEPLOY_PARAMS ?? '').split(',').filter((kv) => kv.includes('=')).map(pair),
  ...args.flatMap((a, i) => (a === '--param' ? [pair(args[i + 1])] : [])),
]);
const env = value('env');
const only = value('only') ?? 'all';
const dryRun = flag('dry-run');
const awsRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

let steps;
try {
  steps = planDeploy({
    env,
    only,
    awsRegion: only === 'all' ? undefined : awsRegion,
    productionApproved: flag('approved') || process.env.DEPLOY_ENVIRONMENT === 'production',
    parameters: Object.keys(params).length ? { global: params, 'cell-uk': params, 'cell-eu': params, 'cell-us': params } : undefined,
    selfSignedTls: flag('self-signed-tls'),
    synth: value('employees') || value('users') ? { employees: Number(value('employees') ?? 200_000), users: Number(value('users') ?? 26_000) } : undefined,
  });
} catch (err) {
  if (err instanceof PlanError) {
    console.error(`deploy: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

const sh = (cmd, cmdArgs, opts = {}) => {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  if (dryRun) return '';
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', env: { ...process.env, ...opts.env } }) ?? '';
};
const aws = (region, ...a) => sh('aws', ['--region', region, '--output', 'json', ...a], { capture: true });
const outputsFile = (stack) => `.deploy/${stack}.json`;
const outputs = (stack) => {
  if (dryRun || !existsSync(outputsFile(stack))) return {};
  return JSON.parse(readFileSync(outputsFile(stack), 'utf8'))[stack] ?? {};
};
const secretString = (region, id) => {
  const r = aws(region, 'secretsmanager', 'get-secret-value', '--secret-id', id);
  return r ? JSON.parse(r).SecretString : '';
};
const putSecret = (region, id, val) => {
  // the value is never printed
  if (dryRun) return console.log(`$ aws --region ${region} secretsmanager put-secret-value --secret-id ${id} --secret-string ***`);
  execFileSync('aws', ['--region', region, 'secretsmanager', 'put-secret-value', '--secret-id', id, '--secret-string', val], { stdio: ['ignore', 'ignore', 'inherit'] });
};

mkdirSync('.deploy', { recursive: true });
console.log(`deploy ${env} ${only}${dryRun ? ' (dry run)' : ''}: ${steps.length} step(s)`);
for (const s of steps) {
  console.log(`\n── ${s.kind} ${s.stack ?? s.secretName ?? s.toSecret ?? ''}${s.database ? ` [${s.database}]` : ''} (${s.region ?? s.to})`);
  switch (s.kind) {
    case 'cdk-deploy': {
      const p = Object.entries(s.parameters).flatMap(([k, v]) => ['--parameters', `${s.stack}:${k}=${v}`]);
      sh('pnpm', ['--filter', '@thapsus/infra', 'exec', 'cdk', 'deploy', s.stack, '-c', `env=${env}`, '--exclusively', '--require-approval', 'never', '--outputs-file', `../${outputsFile(s.stack)}`, ...p], {
        env: { AWS_REGION: s.region, AWS_DEFAULT_REGION: s.region },
      });
      break;
    }
    case 'sync-internal-token': {
      const v = secretString(s.from, s.fromSecret);
      if (v || dryRun) putSecret(s.to, s.toSecret, v);
      break;
    }
    case 'ensure-vapid': {
      const cur = dryRun ? '' : JSON.parse(secretString(s.region, s.secretName) || '{}');
      if (dryRun || !cur.VAPID_PUBLIC_KEY) {
        const webpush = (await import('web-push')).default;
        const k = webpush.generateVAPIDKeys();
        putSecret(s.region, s.secretName, JSON.stringify({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey }));
      }
      break;
    }
    case 'ensure-mock-idp': {
      // Non-production only (the planner never emits this for prod). Self-signed signing material
      // for the mock OIDC/SAML IdP used by `pnpm smoke:staging`.
      const cur = dryRun ? '' : JSON.parse(secretString(s.region, s.secretName) || '{}');
      if (dryRun || !cur.MOCK_IDP_KEY_PEM) {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
        const certPem = dryRun ? '' : execFileSync('openssl', ['req', '-x509', '-key', '/dev/stdin', '-subj', '/CN=thapsus-hr-mock-idp', '-days', '825'], { input: keyPem, encoding: 'utf8' });
        putSecret(s.region, s.secretName, JSON.stringify({ MOCK_IDP_KEY_PEM: keyPem, MOCK_IDP_CERT_PEM: certPem }));
      }
      break;
    }
    case 'run-migrator': {
      // database "shared": the migrator task; a dedicated database: its tools task (default command = migrate).
      const o = outputs(s.stack);
      const net = `awsvpcConfiguration={subnets=[${o.MigratorSubnetIds ?? '<MigratorSubnetIds>'}],securityGroups=[${o.MigratorSecurityGroupId ?? '<MigratorSecurityGroupId>'}],assignPublicIp=DISABLED}`;
      const run = aws(s.region, 'ecs', 'run-task', '--cluster', o.EcsClusterName ?? '<EcsClusterName>', '--task-definition', o[s.taskDefinitionOutput] ?? `<${s.taskDefinitionOutput}>`, '--launch-type', 'FARGATE', '--network-configuration', net);
      if (dryRun) break;
      const task = JSON.parse(run).tasks?.[0]?.taskArn;
      if (!task) throw new Error(`migrator task for the ${s.database} database did not start`);
      aws(s.region, 'ecs', 'wait', 'tasks-stopped', '--cluster', o.EcsClusterName, '--tasks', task);
      const desc = JSON.parse(aws(s.region, 'ecs', 'describe-tasks', '--cluster', o.EcsClusterName, '--tasks', task));
      const code = desc.tasks?.[0]?.containers?.[0]?.exitCode;
      if (code !== 0) throw new Error(`migrator for the ${s.database} database exited with ${code} (see /thapsus-hr/${env}/<cell>/migrator logs)`);
      console.log(`migrations applied (${s.database})`);
      break;
    }
    case 'run-synth': {
      // The migrator task definition with a command override: generates the synthetic enterprise
      // tenant (fictional data only) inside the cell, with more CPU/memory than a migration needs.
      const o = outputs(s.stack);
      const net = `awsvpcConfiguration={subnets=[${o.MigratorSubnetIds ?? '<MigratorSubnetIds>'}],securityGroups=[${o.MigratorSecurityGroupId ?? '<MigratorSecurityGroupId>'}],assignPublicIp=DISABLED}`;
      const overrides = JSON.stringify({
        cpu: '4096',
        memory: '8192',
        containerOverrides: [{ name: 'migrator', command: ['node', 'dist/synth.mjs'], environment: [{ name: 'SYNTH_EMPLOYEES', value: String(s.employees) }, { name: 'SYNTH_USERS', value: String(s.users) }] }],
      });
      const run = aws(s.region, 'ecs', 'run-task', '--cluster', o.EcsClusterName ?? '<EcsClusterName>', '--task-definition', o.MigratorTaskDefinitionArn ?? '<MigratorTaskDefinitionArn>', '--launch-type', 'FARGATE', '--network-configuration', net, '--overrides', overrides);
      if (dryRun) break;
      const task = JSON.parse(run).tasks?.[0]?.taskArn;
      if (!task) throw new Error('synth task did not start');
      // `aws ecs wait tasks-stopped` gives up after 10 minutes; generation can take longer.
      let desc;
      for (let i = 0; i < 360; i++) {
        desc = JSON.parse(aws(s.region, 'ecs', 'describe-tasks', '--cluster', o.EcsClusterName, '--tasks', task));
        if (desc.tasks?.[0]?.lastStatus === 'STOPPED') break;
        await new Promise((r) => setTimeout(r, 10_000));
      }
      const code = desc?.tasks?.[0]?.containers?.[0]?.exitCode;
      if (code !== 0) throw new Error(`synthetic data generation exited with ${code}`);
      console.log(`synthetic tenant generated (${s.employees} employees, ${s.users} sign-in users)`);
      break;
    }
    case 'restart-services': {
      const o = outputs(s.stack);
      for (const svc of ['api', 'worker', 'web']) aws(s.region, 'ecs', 'update-service', '--cluster', o.EcsClusterName ?? '<EcsClusterName>', '--service', `${o.EcsClusterName ?? '<cluster>'}-${svc}`, '--force-new-deployment');
      if (!dryRun) aws(s.region, 'ecs', 'wait', 'services-stable', '--cluster', o.EcsClusterName, '--services', ...['api', 'worker', 'web'].map((x) => `${o.EcsClusterName}-${x}`));
      break;
    }
    case 'health-check': {
      const o = outputs(s.stack);
      const host = o.AlbDnsName ?? '<AlbDnsName>';
      console.log(`GET https://${host}/health${s.insecureTls ? ' (self-signed certificate accepted)' : ''}`);
      if (dryRun) break;
      // Staging without a domain serves an imported self-signed certificate: accepted explicitly, only then.
      const probe = () =>
        new Promise((resolve) => {
          const req = get(`https://${host}/health`, { rejectUnauthorized: !s.insecureTls, timeout: 10_000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.on('timeout', () => req.destroy());
        });
      let ok = false;
      for (let i = 0; i < 30 && !ok; i++) {
        ok = await probe();
        if (!ok) await new Promise((r) => setTimeout(r, 10_000));
      }
      if (!ok) throw new Error(`${s.stack} health check failed`);
      console.log('healthy');
      break;
    }
  }
}
console.log(`\ndeploy ${env} ${only}: done`);
