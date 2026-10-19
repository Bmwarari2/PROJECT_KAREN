import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '@thapsus/sdk';
import { assertSafeUrl, isBlockedAddress, OutboundBlockedError, postOutbound, STRICT_OUTBOUND } from '../src/lib/outbound';
import { signatureHeader, verifySignature } from '../src/lib/signing';
import { webhookRetryDelaySeconds } from '../src/modules/platform/config';
import { isValidSubscription, subscriptionMatches } from '../src/modules/platform/events';
import { scrubPersonRefs } from '../src/modules/platform/sandbox-tables';
import { matchesFilters, streamEvent } from '../src/modules/platform/audit-streams';

describe('SSRF protection for customer-configured destinations', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', 'ff02::1',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111', '1.1.1.1'])('allows public %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it('refuses non-https, credentials in the URL, literal private IPs and internal names', () => {
    const reason = (u: string) => {
      try {
        assertSafeUrl(u, STRICT_OUTBOUND);
        return 'ok';
      } catch (err) {
        return (err as OutboundBlockedError).reason;
      }
    };
    expect(reason('https://hooks.example.com/x')).toBe('ok');
    expect(reason('http://hooks.example.com/x')).toBe('scheme');
    expect(reason('ftp://hooks.example.com/x')).toBe('scheme');
    expect(reason('https://user:pass@hooks.example.com/x')).toBe('credentials');
    expect(reason('https://169.254.169.254/latest/meta-data')).toBe('blockedAddress');
    expect(reason('https://[::1]:8443/x')).toBe('blockedAddress');
    expect(reason('https://10.0.0.5/x')).toBe('blockedAddress');
    expect(reason('https://localhost/x')).toBe('blockedAddress');
    expect(reason('https://metadata.google.internal/x')).toBe('blockedAddress');
    expect(reason('not a url')).toBe('invalidUrl');
  });

  it('blocks at connect time when DNS resolves a public-looking name to a private address (rebinding)', async () => {
    const resolve = (_h: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: '169.254.169.254', family: 4 }]);
    await expect(postOutbound('https://rebind.example.com/hook', '{}', {}, { policy: STRICT_OUTBOUND, resolve: resolve as never, timeoutMs: 2000 })).rejects.toThrow('blocked_address');
    const mixed = (_h: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    await expect(postOutbound('https://mixed.example.com/hook', '{}', {}, { policy: STRICT_OUTBOUND, resolve: mixed as never, timeoutMs: 2000 })).rejects.toThrow('blocked_address');
  });

  it('does not follow redirects and never returns the response body', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end('secret body');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const res = await postOutbound(`http://127.0.0.1:${port}/`, '{}', {}, { policy: { allowHttp: true, allowPrivateNetworks: true } });
    expect(res).toEqual({ status: 302, durationMs: expect.any(Number) });
    await expect(postOutbound(`http://127.0.0.1:${port}/`, '{}', {}, { policy: STRICT_OUTBOUND })).rejects.toThrow();
    server.close();
  });

  it('times out slow receivers with a short error class', async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await expect(postOutbound(`http://127.0.0.1:${port}/`, '{}', {}, { policy: { allowHttp: true, allowPrivateNetworks: true }, timeoutMs: 200 })).rejects.toThrow('timeout');
    server.closeAllConnections();
    server.close();
  });
});

describe('HMAC-SHA256 signatures', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'employee.created', data: { employeeId: '7d0c6a9e-0000-4000-8000-000000000001' } });
  it('sign and verify with the reference verifier and the SDK verifier', () => {
    const header = signatureHeader(['whsec_one'], body, 1_800_000_000);
    expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature(header, body, 'whsec_one', 1_800_000_010)).toBe(true);
    expect(verifyWebhookSignature({ payload: body, header, secrets: ['whsec_one'], now: 1_800_000_010 })).toBe(true);
    expect(verifyWebhookSignature({ payload: body + ' ', header, secrets: ['whsec_one'], now: 1_800_000_010 })).toBe(false);
    expect(verifyWebhookSignature({ payload: body, header, secrets: ['whsec_two'], now: 1_800_000_010 })).toBe(false);
  });
  it('reject stale timestamps (replay protection)', () => {
    const header = signatureHeader(['whsec_one'], body, 1_800_000_000);
    expect(verifyWebhookSignature({ payload: body, header, secrets: ['whsec_one'], now: 1_800_000_301 })).toBe(false);
    expect(verifySignature(header, body, 'whsec_one', 1_799_999_000)).toBe(false);
  });
  it('carry one v1 per active secret during a rotation', () => {
    const header = signatureHeader(['whsec_old', 'whsec_new'], body, 1_800_000_000);
    expect(header.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(2);
    expect(verifyWebhookSignature({ payload: body, header, secrets: ['whsec_old'], now: 1_800_000_000 })).toBe(true);
    expect(verifyWebhookSignature({ payload: body, header, secrets: ['whsec_new'], now: 1_800_000_000 })).toBe(true);
  });
});

describe('webhook policy', () => {
  it('retries with exponential backoff, capped', () => {
    expect([1, 2, 3, 4].map((n) => webhookRetryDelaySeconds(n))).toEqual([30, 60, 120, 240]);
    expect(webhookRetryDelaySeconds(30)).toBe(6 * 3600);
  });
  it('subscriptions accept catalogue events, families and *', () => {
    expect(isValidSubscription('employee.created')).toBe(true);
    expect(isValidSubscription('employee.*')).toBe(true);
    expect(isValidSubscription('*')).toBe(true);
    expect(isValidSubscription('leave.secret_internal')).toBe(false);
    expect(subscriptionMatches(['employee.*'], 'employee.terminated')).toBe(true);
    expect(subscriptionMatches(['employee.created'], 'employee.changed')).toBe(false);
    expect(subscriptionMatches(['*'], 'tenant.created')).toBe(false); // internal topics never leave the cell
  });
});

describe('sandbox configuration scrubbing', () => {
  it('removes person references and turns named approvers into the HR admin role', () => {
    const steps = [{ approver: { type: 'user', value: '0b7f3f86-0000-4000-8000-000000000001' } }, { approver: { type: 'manager' }, escalateTo: { type: 'user', value: 'x' } }];
    expect(scrubPersonRefs({ steps, created_by: 'u1', name: 'Policy', slots: [{ weekday: 1, employeeId: 'e1' }] })).toEqual({
      steps: [{ approver: { type: 'role', value: 'hr_admin' } }, { approver: { type: 'manager' }, escalateTo: { type: 'role', value: 'hr_admin' } }],
      created_by: null,
      name: 'Policy',
      slots: [{ weekday: 1, employeeId: null }],
    });
  });
});

describe('audit stream filters', () => {
  const row = { id: '1', seq: '5', at: '2027-01-01T00:00:00.000Z', actor_type: 'user', actor_id: null, action: 'vault.read', target_type: null, target_id: null, diff: { field: 'health' }, ip: null, user_agent: null, request_id: null, sensitive: true, hash: 'ab' };
  it('match on action prefixes, sensitivity and actor types', () => {
    expect(matchesFilters(row, {})).toBe(true);
    expect(matchesFilters(row, { actions: ['auth.'] })).toBe(false);
    expect(matchesFilters(row, { actions: ['vault.'] })).toBe(true);
    expect(matchesFilters({ ...row, sensitive: false }, { sensitiveOnly: true })).toBe(false);
    expect(matchesFilters(row, { actorTypes: ['api_client'] })).toBe(false);
  });
  it('stream sensitive events without their diff', () => {
    expect(streamEvent(row).diff).toBeNull();
    expect(streamEvent({ ...row, sensitive: false }).diff).toEqual({ field: 'health' });
  });
});
