import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { HomeRegion } from '@thapsus/core/regions';
import { GLOBAL_REGION, names, type EnvConfig } from './config';

export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
/** The CDK bootstrap qualifier (default); bootstrap roles are named cdk-<qualifier>-<kind>-role-<account>-<region>. */
export const CDK_QUALIFIER = 'hnb659fds';

export const deployRoleName = (env: string, region: string) => `thapsus-hr-${env}-deploy-${region}`;

export interface CiStackProps extends StackProps {
  config: EnvConfig;
  /** Every region this environment deploys stacks to (global, cells and backup-copy vaults). */
  deployRegions: string[];
  /** Which cell (if any) lives in each region: post-deploy steps run only there. */
  cellsByRegion: Record<string, HomeRegion>;
}

/**
 * GitHub Actions → AWS without long-lived keys: the GitHub OIDC identity provider plus one deploy role
 * per region. A role can only be assumed by workflows of the configured repository running in the
 * matching GitHub environment, and it can only assume that region's CDK bootstrap roles (which do the
 * CloudFormation and asset work). In a cell region it may also run the post-deploy steps of
 * scripts/deploy.mjs (migrator task, service restart, the cell's own secrets). IAM is global; the
 * stack lives in eu-west-2 with the global layer.
 */
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);
    const { config } = props;
    const { env, account, ci } = config;
    // Native CloudFormation resource (no custom-resource Lambda). One provider per account: when two
    // environments share an account, the second one points `ci.oidcProviderArn` at the first one's.
    const provider = ci.oidcProviderArn
      ? iam.OidcProviderNative.fromOidcProviderArn(this, 'GitHubOidc', ci.oidcProviderArn)
      : new iam.OidcProviderNative(this, 'GitHubOidc', { url: GITHUB_OIDC_URL, clientIds: ['sts.amazonaws.com'] });

    for (const region of props.deployRegions) {
      const role = new iam.Role(this, `Deploy-${region}`, {
        roleName: deployRoleName(env, region),
        description: `GitHub Actions deploys of ${env} stacks in ${region} (${ci.githubRepository}, environment ${ci.githubEnvironment})`,
        assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${ci.githubRepository}:environment:${ci.githubEnvironment}`,
          },
        }),
      });
      const allow = (sid: string, actions: string[], resources: string[], conditions?: Record<string, unknown>) =>
        role.addToPolicy(new iam.PolicyStatement({ sid, actions, resources, conditions }));

      allow(
        'AssumeCdkBootstrapRolesInThisRegionOnly',
        ['sts:AssumeRole', 'sts:TagSession'],
        ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map((kind) => `arn:aws:iam::${account}:role/cdk-${CDK_QUALIFIER}-${kind}-role-${account}-${region}`),
      );
      allow('ReadStackOutputs', ['cloudformation:DescribeStacks'], [`arn:aws:cloudformation:${region}:${account}:stack/ThapsusHr-${env}-*/*`]);
      new CfnOutput(this, `DeployRoleArn${region.replace(/-/g, '')}`, { value: role.roleArn, description: `Deploy role for ${region}` });

      const cell = props.cellsByRegion[region];
      if (!cell) continue;
      const prefix = `thapsus-hr-${env}-${cell}`;
      allow('RunMigrator', ['ecs:RunTask'], [`arn:aws:ecs:${region}:${account}:task-definition/${prefix}-migrator:*`]);
      allow('WatchTasks', ['ecs:DescribeTasks'], [`arn:aws:ecs:${region}:${account}:task/${prefix}/*`]);
      allow('RestartServices', ['ecs:UpdateService', 'ecs:DescribeServices'], [`arn:aws:ecs:${region}:${account}:service/${prefix}/*`]);
      allow('PassTaskRolesToEcs', ['iam:PassRole'], [`arn:aws:iam::${account}:role/ThapsusHr-${env}-cell-${cell}-*`], { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });
      allow(
        'CellSecrets',
        ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:DescribeSecret'],
        [names.cellInternalTokenSecret(env, cell), `thapsus-hr/${env}/vapid`, `thapsus-hr/${env}/mock-idp`].map((n) => `arn:aws:secretsmanager:${region}:${account}:secret:${n}-*`),
      );
      allow('CellSecretsKms', ['kms:Decrypt', 'kms:GenerateDataKey'], [`arn:aws:kms:${region}:${account}:key/*`], { StringEquals: { 'kms:ViaService': `secretsmanager.${region}.amazonaws.com` } });
      // The single cross-region exception: read the env's internal service token (not personal data)
      // from the global layer so the cell's own copy can be filled.
      allow('ReadGlobalInternalToken', ['secretsmanager:GetSecretValue'], [`arn:aws:secretsmanager:${GLOBAL_REGION}:${account}:secret:${names.internalTokenSecret(env)}-*`]);
      allow('ReadGlobalInternalTokenKms', ['kms:Decrypt'], [`arn:aws:kms:${GLOBAL_REGION}:${account}:key/*`], { StringEquals: { 'kms:ViaService': `secretsmanager.${GLOBAL_REGION}.amazonaws.com` } });
    }
    if (!ci.oidcProviderArn) new CfnOutput(this, 'GitHubOidcProviderArn', { value: provider.oidcProviderArn });
  }
}
