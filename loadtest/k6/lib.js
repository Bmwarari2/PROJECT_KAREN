// Shared helpers for the Thapsus-HR k6 scenarios. All users are fictional synthetic users created by
// `pnpm synth:enterprise` (user<N>@globex.example.test). No real personal data is ever used.
import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
export const TENANT = __ENV.TENANT || 'enterprise';
export const PASSWORD = __ENV.SYNTH_PASSWORD || 'Demo-Password-2026';
export const USERS = Number(__ENV.SYNTH_USERS || 6000);
/** The first USERS/8 synthetic users are managers (see synth-enterprise.ts). */
export const MANAGERS = Math.floor(USERS / 8);
export const INSECURE = __ENV.INSECURE_TLS === 'true';

export const params = (cookie, tags = {}) => ({
  headers: { cookie, 'content-type': 'application/json', accept: 'application/json' },
  tags,
});

/** Signs in a synthetic user and returns the session cookie plus the session. */
export function login(n) {
  const email = `user${n}@globex.example.test`;
  const res = http.post(
    `${BASE}/v1/auth/login`,
    JSON.stringify({ tenant: TENANT, email, password: PASSWORD }),
    { headers: { 'content-type': 'application/json' }, tags: { type: 'login', name: 'POST /v1/auth/login' } },
  );
  if (!check(res, { 'login 200': (r) => r.status === 200 }))
    fail(`login failed for user ${n}: ${res.status}`);
  const sid = res.cookies.thr_sid && res.cookies.thr_sid[0];
  if (!sid) fail('no session cookie');
  const cookie = `thr_sid=${sid.value}`;
  const session = http
    .get(`${BASE}/v1/auth/session`, params(cookie, { type: 'read', name: 'GET /v1/auth/session' }))
    .json();
  return { cookie, session };
}

export const uuidish = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

// ---- TOTP (RFC 6238) for the admin session used by the list scenario ---------------------------------
import crypto from 'k6/crypto';

function base32ToBytes(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out.buffer;
}

export function totp(secret, at = Date.now()) {
  const counter = Math.floor(at / 1000 / 30);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const mac = new Uint8Array(crypto.hmac('sha1', base32ToBytes(secret), msg.buffer, 'binary'));
  const o = mac[mac.length - 1] & 0x0f;
  const code = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** The synthetic tenant owner (all-scope admin), signed in with MFA enrolled — the load-test env is fresh each run. */
export function adminSession() {
  const res = http.post(
    `${BASE}/v1/auth/login`,
    JSON.stringify({ tenant: TENANT, email: `owner@${TENANT}.example.test`, password: PASSWORD }),
    { headers: { 'content-type': 'application/json' }, tags: { type: 'login' } },
  );
  if (res.status !== 200) fail(`owner login failed: ${res.status}`);
  const cookie = `thr_sid=${res.cookies.thr_sid[0].value}`;
  const body = res.json();
  if (body.mfaEnrollmentRequired) {
    const enrol = http.post(`${BASE}/v1/auth/mfa/totp/enroll`, '{}', params(cookie, { type: 'login' })); // JSON content type needs a body
    if (enrol.status !== 200) fail(`MFA enrolment failed: ${enrol.status}`);
    const secret = enrol.json('secret');
    const ok = http.post(
      `${BASE}/v1/auth/mfa/totp/confirm`,
      JSON.stringify({ code: totp(secret) }),
      params(cookie, { type: 'login' }),
    );
    if (ok.status !== 204) fail(`MFA confirm failed: ${ok.status}`);
  } else if (__ENV.OWNER_TOTP_SECRET) {
    const ok = http.post(
      `${BASE}/v1/auth/mfa/totp/verify`,
      JSON.stringify({ code: totp(__ENV.OWNER_TOTP_SECRET) }),
      params(cookie, { type: 'login' }),
    );
    if (ok.status !== 204) fail(`MFA verify failed: ${ok.status}`);
  } else fail('the owner already has MFA: set OWNER_TOTP_SECRET or use a fresh load-test environment');
  return cookie;
}
