import { afterEach, describe, expect, it } from 'vitest';
import { loadCellConfig } from '../src/config';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('cell configuration', () => {
  it('per-IP throttles are unchanged unless configured, and can only be relaxed outside production', () => {
    delete process.env.IP_THROTTLE_MULTIPLIER;
    expect(loadCellConfig().ipThrottleMultiplier).toBe(1);
    Object.assign(process.env, { APP_ENV: 'loadtest', IP_THROTTLE_MULTIPLIER: '1000' });
    expect(loadCellConfig()).toMatchObject({ env: 'loadtest', ipThrottleMultiplier: 1000 });
    Object.assign(process.env, { APP_ENV: 'prod', IP_THROTTLE_MULTIPLIER: '10' });
    expect(() => loadCellConfig()).toThrow(/production/);
    Object.assign(process.env, { APP_ENV: 'staging', IP_THROTTLE_MULTIPLIER: '0.5' });
    expect(() => loadCellConfig()).toThrow(/>= 1/);
  });

  it('rejects unknown environments', () => {
    process.env.APP_ENV = 'qa';
    expect(() => loadCellConfig()).toThrow(/Invalid APP_ENV/);
  });
});
