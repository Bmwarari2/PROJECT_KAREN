import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';
import { REGIONS, type HomeRegion } from '@thapsus/core/regions';
import { names, type EnvConfig } from './config';

export interface BackupCopyVaultStackProps extends StackProps {
  config: EnvConfig;
  cell: HomeRegion;
}

/**
 * Backup copy target for one cell, deployed ONLY in that cell's permitted backup region
 * (EU → eu-west-1, US → us-west-1; UK has none). The cell's backup plan addresses this vault by its
 * name-based ARN, so there is no cross-region stack reference.
 */
export class BackupCopyVaultStack extends Stack {
  constructor(scope: Construct, id: string, props: BackupCopyVaultStackProps) {
    super(scope, id, props);
    const { config: cfg, cell } = props;
    const target = REGIONS[cell].backupRegion;
    if (!target) throw new Error(`Cell ${cell} has no permitted backup region; no copy vault may exist`);
    if (this.region !== target) throw new Error(`Copy vault for ${cell} must be in ${target}, not ${this.region}`);
    const key = new kms.Key(this, 'CopyVaultKey', {
      alias: `alias/thapsus-hr-${cfg.env}-${cell}-backup-copy`,
      description: `Thapsus-HR ${cfg.env} ${cell} backup copies`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const vault = new backup.BackupVault(this, 'CopyVault', {
      backupVaultName: names.copyVault(cfg.env, cell),
      encryptionKey: key,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new CfnOutput(this, 'CopyVaultArn', { value: vault.backupVaultArn });
  }
}
