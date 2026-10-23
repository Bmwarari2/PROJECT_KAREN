import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { Storage } from '@google-cloud/storage';
import type { HomeRegion } from '@thapsus/core';
import { createAwsClientFactory } from '@thapsus/core/aws';
import { GuardedBucket } from './gcs';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** Region the mail is sent from (emails stay in the tenant's home region). */
  readonly region: HomeRegion;
  send(mail: Mail): Promise<void>;
}

export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  constructor(readonly region: HomeRegion) {}
  async send(mail: Mail) {
    this.sent.push(mail);
  }
}

/**
 * Local development and end-to-end tests only: writes each email as a JSON file in `dir` so tools and
 * tests can read it (e.g. a sign-in link). Refused in staging and production (see mailerFromEnv).
 */
export class FileMailer implements Mailer {
  constructor(
    readonly region: HomeRegion,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }
  async send(mail: Mail) {
    mkdirSync(this.dir, { recursive: true }); // the directory may be cleared between test runs
    writeFileSync(join(this.dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(mail));
  }
}

export class SmtpMailer implements Mailer {
  private transport;
  constructor(
    readonly region: HomeRegion,
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(mail: Mail) {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

/** Amazon SES in the cell's home region, via the residency-guarded factory. */
export class SesMailer implements Mailer {
  private client: SESv2Client;
  constructor(
    readonly region: HomeRegion,
    private readonly from: string,
    private readonly configurationSet?: string,
  ) {
    this.client = createAwsClientFactory({ cell: region })(SESv2Client, 'ses');
  }
  async send(mail: Mail) {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [mail.to] },
        ConfigurationSetName: this.configurationSet,
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: mail.text, Charset: 'UTF-8' },
              ...(mail.html ? { Html: { Data: mail.html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      }),
    );
  }
}

/**
 * Staging email capture (Google Cloud staging has no email provider yet, ADR-0156): each message is written as an
 * RFC 822 `.eml` object to a bucket in the cell's region, checked on first use. Object names hold only the UTC date,
 * time and a random id, never an address or a subject. Refused in production (see mailerFromEnv); the bucket is
 * private and its lifecycle rule deletes old messages.
 */
export class BucketMailer implements Mailer {
  private readonly guarded: GuardedBucket;
  private readonly now: () => Date;
  constructor(
    readonly region: HomeRegion,
    bucket: string,
    private readonly from: string,
    opts: { storage?: Storage; now?: () => Date } = {},
  ) {
    this.guarded = new GuardedBucket(region, bucket, opts.storage);
    this.now = opts.now ?? (() => new Date());
  }
  async send(mail: Mail) {
    const bucket = await this.guarded.bucket();
    const eml = await new MailComposer({ from: this.from, ...mail }).compile().build();
    const at = this.now().toISOString(); // 2026-10-23T09:08:07.654Z
    const name = `mail/${at.slice(0, 10)}/${at.slice(11, 19).replaceAll(':', '')}-${randomUUID()}.eml`;
    await bucket.file(name).save(eml, { contentType: 'message/rfc822', resumable: false });
  }
}

export function mailerFromEnv(cell: HomeRegion, env: NodeJS.ProcessEnv = process.env): Mailer {
  const from = env.MAIL_FROM ?? `no-reply@${env.THAPSUS_HR_DOMAIN ?? 'thapsus-hr.localhost'}`;
  if (env.MAIL_TRANSPORT === 'ses') return new SesMailer(cell, from, env.SES_CONFIGURATION_SET);
  if (env.MAIL_TRANSPORT === 'bucket') {
    if (env.APP_ENV !== 'dev' && env.APP_ENV !== 'test' && env.APP_ENV !== 'staging')
      throw new Error('MAIL_TRANSPORT=bucket is only allowed in dev, test and staging');
    if (!env.MAIL_BUCKET) throw new Error('MAIL_TRANSPORT=bucket needs MAIL_BUCKET');
    return new BucketMailer(cell, env.MAIL_BUCKET, from);
  }
  if (env.MAIL_TRANSPORT === 'file') {
    if (env.APP_ENV !== 'dev' && env.APP_ENV !== 'test')
      throw new Error('MAIL_TRANSPORT=file is only allowed in dev and test');
    return new FileMailer(cell, env.MAIL_DIR ?? '.tmp/mail');
  }
  if (env.SMTP_URL) return new SmtpMailer(cell, env.SMTP_URL, from);
  return new MemoryMailer(cell);
}
