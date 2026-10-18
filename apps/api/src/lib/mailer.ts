import nodemailer from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { HomeRegion } from '@thapsus/core';
import { createAwsClientFactory } from '@thapsus/core/aws';

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
            Body: { Text: { Data: mail.text, Charset: 'UTF-8' }, ...(mail.html ? { Html: { Data: mail.html, Charset: 'UTF-8' } } : {}) },
          },
        },
      }),
    );
  }
}

export function mailerFromEnv(cell: HomeRegion, env: NodeJS.ProcessEnv = process.env): Mailer {
  const from = env.MAIL_FROM ?? `no-reply@${env.THAPSUS_HR_DOMAIN ?? 'thapsus-hr.localhost'}`;
  if (env.MAIL_TRANSPORT === 'ses') return new SesMailer(cell, from, env.SES_CONFIGURATION_SET);
  if (env.SMTP_URL) return new SmtpMailer(cell, env.SMTP_URL, from);
  return new MemoryMailer(cell);
}
