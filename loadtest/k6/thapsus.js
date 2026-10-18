// k6 scenarios for brief §3 (run by scripts/loadtest.mjs):
//   common_reads     — 5,000 concurrent signed-in users doing common reads   (p95 < 300 ms)
//   paginated_lists  — managers paging through people lists at 200,000 employees (p95 < 1 s)
//   clock_in_burst   — 20,000 clock-ins within 10 minutes (each a distinct synthetic employee)
// PROFILE=smoke runs a tiny version of the same scenarios (local validation before an AWS run).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';
import { BASE, USERS, adminSession, login, params, uuidish } from './lib.js';

const smoke = __ENV.PROFILE === 'smoke';
const clockIns = new Counter('clock_ins_created');

const VUS = smoke ? 10 : Number(__ENV.CONCURRENT_USERS || 5000);
const HOLD = smoke ? '30s' : __ENV.HOLD || '10m';
const CLOCK_TARGET = smoke ? 50 : Number(__ENV.CLOCK_INS || 20000);
const CLOCK_WINDOW_S = smoke ? 30 : 600;

export const options = {
  insecureSkipTLSVerify: __ENV.INSECURE_TLS === 'true',
  discardResponseBodies: false,
  scenarios: {
    common_reads: {
      executor: 'ramping-vus',
      exec: 'commonReads',
      startVUs: 0,
      stages: [
        { duration: smoke ? '10s' : '5m', target: VUS },
        { duration: HOLD, target: VUS },
        { duration: smoke ? '5s' : '1m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
    paginated_lists: {
      executor: 'constant-vus',
      exec: 'paginatedLists',
      vus: smoke ? 2 : Number(__ENV.LIST_USERS || 250),
      duration: smoke ? '40s' : '15m',
    },
    clock_in_burst: {
      // a fixed number of iterations spread evenly across the window: exactly CLOCK_TARGET clock-ins
      executor: 'constant-arrival-rate',
      exec: 'clockIn',
      rate: Math.ceil(CLOCK_TARGET / CLOCK_WINDOW_S),
      timeUnit: '1s',
      duration: `${CLOCK_WINDOW_S}s`,
      preAllocatedVUs: smoke ? 5 : 400,
      maxVUs: smoke ? 20 : 2000,
      startTime: smoke ? '0s' : '6m', // during the concurrent-user plateau
    },
  },
  thresholds: {
    'http_req_duration{type:read}': ['p(95)<300'],
    'http_req_duration{type:list}': ['p(95)<1000'],
    'http_req_duration{type:clock}': ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    clock_ins_created: [`count>=${CLOCK_TARGET}`],
  },
};

/** One all-scope admin session (MFA enrolled) shared by the list VUs: HR admins browsing 200,000 people. */
export function setup() {
  return { adminCookie: adminSession() };
}

// Each read VU signs in once as its own synthetic user and keeps the session (like a real browser tab).
// Read users are 1..VUS; clock-in users start above them so every clock-in is a distinct employee.
let me;
function session() {
  if (!me) me = login(((exec.vu.idInTest - 1) % VUS) + 1);
  return me;
}

export function commonReads() {
  const { cookie, session: s } = session();
  const id = s.employeeId;
  const reads = [
    ['GET /v1/auth/session', '/v1/auth/session'],
    ['GET /v1/employees/:id', `/v1/employees/${id}`],
    ['GET /v1/leave/balances/:id', `/v1/leave/balances/${id}`],
    ['GET /v1/me/shifts', `/v1/me/shifts?from=${today()}&to=${addDays(today(), 7)}`],
    ['GET /v1/clock/status', '/v1/clock/status'],
    ['GET /v1/org-chart/:id/focus', `/v1/org-chart/${id}/focus`],
  ];
  for (const [name, path] of reads) {
    const r = http.get(`${BASE}${path}`, params(cookie, { type: 'read', name }));
    check(r, { [`${name} 200`]: (x) => x.status === 200 });
  }
  sleep(1 + Math.random() * 2); // think time
}

export function paginatedLists(data) {
  const cookie = data.adminCookie;
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const r = http.get(`${BASE}/v1/employees?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, params(cookie, { type: 'list', name: 'GET /v1/employees (page)' }));
    if (!check(r, { 'list 200': (x) => x.status === 200 })) return;
    cursor = r.json('nextCursor');
    if (!cursor) break;
  }
  const s = http.get(`${BASE}/v1/employees?limit=50&q=${['smith', 'garc', 'mül', 'nguyen'][Math.floor(Math.random() * 4)]}`, params(cookie, { type: 'list', name: 'GET /v1/employees?q (search)' }));
  check(s, { 'search 200': (x) => x.status === 200 });
  sleep(2);
}

export function clockIn() {
  // a distinct employee for every iteration, above the read users' range (needs SYNTH_USERS ≥ VUS + CLOCK_INS)
  const n = ((VUS + exec.scenario.iterationInTest) % USERS) + 1;
  const { cookie } = login(n);
  const body = JSON.stringify({ events: [{ clientEventId: `lt:${n}:${uuidish()}`, kind: 'in', occurredAt: new Date().toISOString() }] });
  const r = http.post(`${BASE}/v1/clock/events`, body, params(cookie, { type: 'clock', name: 'POST /v1/clock/events' }));
  const ok = check(r, { 'clock 200': (x) => x.status === 200, 'clock created': (x) => x.status === 200 && x.json('results.0.status') !== 'rejected' });
  if (ok) clockIns.add(1);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function handleSummary(data) {
  return { stdout: textSummary(data), [__ENV.SUMMARY_FILE || 'loadtest-summary.json']: JSON.stringify(data, null, 2) };
}
function textSummary(data) {
  const m = data.metrics;
  const p = (k, q) => (m[k] && m[k].values[q] !== undefined ? `${Math.round(m[k].values[q])} ms` : 'n/a');
  return [
    '',
    'Thapsus-HR load test summary',
    `  common reads p95:     ${p('http_req_duration{type:read}', 'p(95)')} (target < 300 ms)`,
    `  paginated lists p95:  ${p('http_req_duration{type:list}', 'p(95)')} (target < 1000 ms)`,
    `  clock-in p95:         ${p('http_req_duration{type:clock}', 'p(95)')}`,
    `  clock-ins created:    ${m.clock_ins_created ? m.clock_ins_created.values.count : 0} (target ${CLOCK_TARGET} in ${CLOCK_WINDOW_S}s)`,
    `  peak VUs:             ${m.vus_max ? m.vus_max.values.max : 'n/a'}`,
    `  failed requests:      ${m.http_req_failed ? (m.http_req_failed.values.rate * 100).toFixed(2) : 'n/a'} %`,
    '',
  ].join('\n');
}
