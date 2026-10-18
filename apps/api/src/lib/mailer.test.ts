import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileMailer, mailerFromEnv } from './mailer';

describe('mailerFromEnv', () => {
  it('writes each email as a JSON file in dev and test, for local tools and end-to-end tests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thr-mail-'));
    const mailer = mailerFromEnv('uk', { APP_ENV: 'test', MAIL_TRANSPORT: 'file', MAIL_DIR: dir });
    expect(mailer).toBeInstanceOf(FileMailer);
    await mailer.send({ to: 'joiner@example.test', subject: 'Hello', text: 'Link: https://app.example.test/x' });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'))).toEqual({ to: 'joiner@example.test', subject: 'Hello', text: 'Link: https://app.example.test/x' });
  });

  it('refuses the file transport outside dev and test', () => {
    for (const APP_ENV of ['staging', 'prod', undefined]) expect(() => mailerFromEnv('uk', { APP_ENV, MAIL_TRANSPORT: 'file', MAIL_DIR: tmpdir() })).toThrow(/only allowed in dev and test/);
  });
});
