# Thapsus-HR public API

The Thapsus-HR REST API is versioned (`/v1`), described by an OpenAPI 3.1 document generated from the route schemas, and contract-tested against the implementation. This page is the API documentation deliverable of brief §9. The same material is published in the app at **/developers**, with a reference generated from the spec at build time. The raw spec is at `/openapi.json` and in `packages/sdk/openapi.json`.

- **Base URL:** your workspace's home region only: `https://api.uk.<domain>`, `https://api.eu.<domain>` or `https://api.us.<domain>`.
  - A request for a workspace that lives in another region gets `421` with the correct URL. No data is read.
  - Responses always carry `Cache-Control: private, no-store` and are never cached at an edge.
- **Format:** JSON in and out. Errors are RFC 9457 problem documents (`application/problem+json`) with a stable `code` and, where relevant, a `detail`. Examples: `featureDisabled`, `apiClientNotAllowed`, `idempotencyKeyReused`.
- **SDK:** `@thapsus/sdk` is a typed client generated from the spec (openapi-fetch). It includes `createThapsusClient`, `getClientCredentialsToken`, `paginate` and `verifyWebhookSignature`.

## Authentication

Machine clients use one of two credentials. Both are created by a company admin in **Settings → API access** (`/v1/settings/api-keys`, `/v1/settings/oauth-clients`). Secrets are shown once and stored only as SHA-256 hashes.

| Credential | Format | How to use |
| --- | --- | --- |
| Scoped API key | `thr_sk_<workspace id>.<secret>` | `Authorization: Bearer thr_sk_…`. Revocable. It can have an expiry date, and its last-used time is recorded. |
| OAuth 2.0 client | client id `thr_ci_…`, secret `thr_cs_…` | Exchange it for a short-lived access token (`thr_at_…`, 1 hour by default) with the client credentials grant, then `Authorization: Bearer thr_at_…`. |

**Token request** (RFC 6749 §4.4). Authenticate with HTTP Basic (`client_secret_basic`, preferred) or with form fields (`client_secret_post`):

```http
POST /v1/oauth/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&scope=employees%3Aread%20org%3Aread
```

```json
{ "access_token": "thr_at_…", "token_type": "Bearer", "expires_in": 3600, "scope": "employees:read org:read" }
```

- **Errors** follow RFC 6749 §5.2: `invalid_client` (401, with `WWW-Authenticate: Basic` when Basic was used), `invalid_request`, `unsupported_grant_type`, `invalid_scope` and `unauthorized_client` (the public API is turned off for the workspace).
- **Rotating a client secret:** `POST /v1/settings/oauth-clients/{id}/rotate-secret` with `{ "graceHours": 24 }`. The old secret keeps working until the grace period ends.
- **Revoking a client** also revokes every token it holds.

## Scopes and roles

Every credential has a **role** (built-in or custom) and one or more **scopes**. Its effective permissions are the **intersection** of the two. A scope never adds permissions the role lacks, and the role never adds permissions outside the scopes. Admins cannot create a credential with permissions they do not hold themselves (`403 exceedsYourPermissions`). A credential can also be limited to entities, countries, departments or locations (`scopeType`, `scopeValues`).

| Scope | Allows |
| --- | --- |
| `employees:read` | `employees.read`, `employees.history` |
| `employees:write` | the above plus `employees.create`, `employees.update`, `employees.terminate` |
| `org:read` / `org:write` | organisation reference data (`org.read`, `employees.read`) / `org.manage`, `org.reporting` |
| `leave:read` / `leave:write` | time off and absence (read) / record, manage and adjust |
| `time:read` / `time:write` | rotas, clock events, timesheets, export / rota and timesheet management |
| `documents:read` / `documents:write` | documents (read) / manage |
| `audit:read` | read and export the audit log |
| `webhooks:manage` | manage webhook endpoints (`/v1/webhooks`) |

The source of this table is `packages/core/src/api-scopes.ts`.

- **Endpoints open to credentials:** API clients may call only the public resource paths listed there, for example `/v1/employees`, `/v1/org`, `/v1/leave`, `/v1/shifts`, `/v1/timesheets`, `/v1/documents`, `/v1/audit/events` and `/v1/webhooks`.
- **Endpoints for people only:** sign-in, MFA, the caller's own profile, settings and the back office answer `403 apiClientNotAllowed`.
- **Audit:** every change an API client makes is audited with `actor_type = api_client` and the key or client id as the actor.

## Pagination

List endpoints take `?limit=` (1–200; the default varies by endpoint) and `?cursor=`, and return:

```json
{ "data": [ … ], "nextCursor": "eyJ…" }
```

Pass `nextCursor` back as `cursor` until it is `null`. Cursors are opaque keyset positions: they stay stable while rows are inserted and are not page numbers. With the SDK:

```ts
for await (const e of paginate((cursor) => client.GET('/v1/employees', { params: { query: { limit: 200, cursor } } }))) { … }
```

## Idempotency

Send `Idempotency-Key: <1–255 visible ASCII characters>` on `POST` and `PATCH`.

- **Same key, same method, path and body:** the stored response (status and body) is replayed with `Idempotent-Replayed: true`. Nothing runs twice.
- **Same key, different request:** `422` with `detail: idempotencyKeyReused`.
- **Same key while the first request is still running:** `409` with `detail: idempotencyKeyInProgress`.
- **Scope and lifetime:** keys are scoped to your workspace and to the caller (API key, OAuth client or person). They are kept for **24 hours**; an hourly job purges expired keys.
- **What is stored:** server errors (5xx) are not stored, so you can retry them with the same key.

The SDK can generate keys for you: `createThapsusClient({ idempotencyKey: () => crypto.randomUUID() })`.

## Rate limits

- **Scope:** limits apply per **workspace**, per minute, across all of its API keys and OAuth clients. People using the web app are not counted.
- **Defaults:** they come from the plan (`apps/api/src/modules/platform/config.ts`), and Thapsus can set a per-workspace override in the back office.
- **Headers on every API-client response:** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds) and `RateLimit-Policy: <limit>;w=60`.
- **Over the limit:** you get `429` with `Retry-After` and `code: rateLimited`. Back off for `Retry-After` seconds.

## Versioning and deprecation

- **Version in the path:** the major version is in the path (`/v1`). Within a version we only make additive changes: new endpoints, new optional fields, new enum values in responses and new error `detail` codes. Clients must ignore unknown fields.
- **Breaking changes:** these ship as a new major version (`/v2`), which runs side by side with the previous one.
- **Deprecated operations:** they are marked `deprecated: true` in the spec and send these headers at least **6 months** before removal:
  - `Deprecation: @<unix time>` (RFC 9745)
  - `Sunset: <HTTP date>` (RFC 8594)
  - `Link: <migration guide>; rel="deprecation"`

  The mechanism is the route config `deprecation: { since, sunset, link }` (`apps/api/src/modules/platform/http.ts`).

## Webhooks

Admins add endpoints in **Settings → Webhooks** or with `POST /v1/webhooks` (scope `webhooks:manage`). URLs must be public `https://` addresses. Loopback, private, link-local, carrier-grade NAT, cloud metadata and documentation ranges are refused. This also applies to their IPv4-mapped and NAT64 forms, and it is checked again at connect time for every resolved address, so DNS rebinding cannot reach internal hosts. Redirects are not followed.

**Events.** Subscribe to `employee.created`, `employee.changed`, `employee.transferred`, `employee.terminated`, `integration.requested`, a family wildcard such as `employee.*`, or `*`. `POST /v1/webhooks/{id}/ping` sends a `webhook.ping` event. Payloads carry identifiers and the names of changed fields only, never field values:

```json
{ "id": "evt_1234", "type": "employee.changed", "createdAt": "2026-10-18T09:00:00.000Z",
  "data": { "employeeId": "0b7f…", "effectiveDate": "2026-11-01", "fields": ["jobTitle"] } }
```

**Headers:**

| Header | Value |
| --- | --- |
| `Thapsus-Signature` | `t=<unix seconds>,v1=<signature>[,v1=<signature>]` |
| `Thapsus-Event-Id` | Stable per event, including across retries and replays. Use it to de-duplicate. |
| `Thapsus-Event-Type`, `Thapsus-Delivery-Id`, `Thapsus-Delivery-Attempt` | Event type, delivery id and attempt number |

### Verifying signatures

`v1 = hex(HMAC-SHA256(signing secret, "<t>.<raw request body>"))`. Verify a delivery like this:

1. Read the **raw** body bytes, before any JSON parsing.
2. Split the header on `,` and take `t` and every `v1`.
3. Reject the delivery if `|now − t| > 300` seconds. This stops replays.
4. Compute the HMAC with your secret and compare it with each `v1` in constant time. Accept if any matches.

```ts
import { verifyWebhookSignature } from '@thapsus/sdk';
const ok = verifyWebhookSignature({ payload: rawBody, header: req.headers['thapsus-signature'], secrets: [process.env.THAPSUS_WEBHOOK_SECRET!] });
```

**Secret rotation:** `POST /v1/webhooks/{id}/rotate-secret` with `{ "graceHours": 24 }` returns the new secret once.

- During the grace period each delivery carries **two** `v1` signatures, one per active secret, so you can switch at any moment.
- After the grace period only the new secret signs.

**Retries:**

- A delivery succeeds on any `2xx` response. Anything else, including redirects, timeouts (10 s) and connection errors, is retried with exponential backoff: 30 s, 1 min, 2 min, 4 min and so on (capped at 6 h), up to **8 attempts**, after which the delivery is marked `failed`.
- Each attempt is a separate idempotent job, so a worker crash never sends an attempt twice. Even so, de-duplicate on `Thapsus-Event-Id`.

**Delivery log and replay:**

- `GET /v1/webhooks/{id}/deliveries` lists deliveries: status, attempts, last response code, duration and error class.
- `GET /v1/webhooks/deliveries/{id}` shows one delivery with every attempt. The receiver's response body is never stored.
- `POST /v1/webhooks/deliveries/{id}/replay` sends the same event again, with the same event id and a fresh signature.

## Audit log streaming (SIEM)

**Settings → Audit log streaming** (`/v1/settings/audit-streams`) sends your sealed, hash-chained audit log to your SIEM. Each event includes its `seq` and chain `hash`. You can filter by action prefix, sensitive-only and actor type. Events about sensitive data are streamed without their diff.

| Destination | How it works |
| --- | --- |
| HTTPS | `POST` of `{ streamId, batchId, fromSeq, toSeq, count, events: [...] }`, signed exactly like webhooks. `Idempotency-Key` and `Thapsus-Batch-Id` are both the batch id. |
| Amazon S3 | Your bucket, **in your workspace's home region**. Thapsus assumes an IAM role in your account whose **name starts with `thapsus-hr-audit-`** (`sts:AssumeRole` with the external id shown when you create the stream) and writes NDJSON objects to `<prefix>YYYY/MM/DD/<fromSeq>-<toSeq>.ndjson`. |

**Setting up an S3 stream:**

1. Create the stream with your bucket name, an optional key prefix and the ARN of the role you are about to create. The bucket must be in your home region: `eu-west-2` (UK), `eu-central-1` (EU) or `us-east-2` (US); any other region is refused with `422 regionNotAllowed`. After saving, the stream shows an **External ID** (`thapsus-…`). Copy it.
2. In your AWS account, create an IAM role whose **name starts with `thapsus-hr-audit-`** (for example `thapsus-hr-audit-siem`), without a path. Thapsus-HR can only assume roles with this prefix: any other name is refused with `422 roleNotAllowed` (the problem also carries `rolePrefix`). Within the Thapsus-HR account, only the worker of your home region may call `sts:AssumeRole`, and only on `arn:aws:iam::*:role/thapsus-hr-audit-*`. This prefix is separate from the data-export prefix (`thapsus-hr-export-`).
3. Trust policy (replace the account ID with the Thapsus-HR account for your region, which support gives you, and the External ID with yours):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "AWS": "arn:aws:iam::<THAPSUS_HR_ACCOUNT_ID>:root" },
         "Action": "sts:AssumeRole",
         "Condition": { "StringEquals": { "sts:ExternalId": "<external id from step 1>" } }
       }
     ]
   }
   ```

4. Permissions policy (least privilege; replace the bucket and prefix): allow `s3:PutObject` on `arn:aws:s3:::<bucket>/<prefix>*`. Objects are written with `x-amz-server-side-encryption: aws:kms`; if the bucket's default key is your own KMS key, also allow `kms:GenerateDataKey` on that key.

Sessions last 15 minutes and are created per delivery. Thapsus-HR stores no long-lived AWS keys for your account. A delivery that cannot assume the role is recorded as failed in the delivery log and retried on the next sync.

**Delivery:**

- Batches are idempotent. A retry resends exactly the same sequence range, with the same batch id or object key, so duplicates are harmless.
- A cursor records the last delivered sequence.
- Delivery is near real time: at most a minute while your workspace is active, and within five minutes otherwise. `POST …/{id}/sync` delivers immediately.
- `GET …/{id}/batches` is the delivery log.

## Data residency of outbound calls

Webhooks and audit streams go only to destinations that **you**, the controller, configure. They are not Thapsus sub-processors (see `docs/SUBPROCESSORS.md`). Every outbound call originates from your workspace's home region. S3 destinations must be in that region.

## Sandboxes, feature flags and branding (admin API)

These endpoints are for admins signed in to the app, not for API credentials:

- `/v1/sandboxes`: create a sandbox from your configuration with synthetic people. No personal data is copied.
- `/v1/settings/features`: turn features on or off.
- `/v1/settings/branding`: set the accent colour (checked for WCAG 2.2 AA contrast in light and dark mode) and the logo.
- `/v1/tenant/experience`: the flags and branding the app shell applies.
