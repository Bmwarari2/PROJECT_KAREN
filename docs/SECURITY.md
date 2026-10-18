# Security

Target: OWASP ASVS level 2. This document records the security controls and where each is proven, and will include the STRIDE threat model (Phase 12).

## Controls

| Area | Control | Proof |
| --- | --- | --- |
| Tenant isolation | Forced RLS on every tenant table; composite tenant foreign keys; non-owner app role without BYPASSRLS; transaction-local tenant context | `packages/db/test/rls.isolation.test.ts` (enumerates every table from the catalog) |
| Data residency | Guarded AWS client factory; startup endpoint check; router refuses foreign tenants; CDK region assertions | `*.residency.test.ts`, `infra/test` |
| Authentication | Argon2id (19 MiB, t=2); a 12-character minimum; constant-time unknown-user path; per-IP and per-account throttles; lockout after N failures (per tenant) | `apps/api/test/auth.int.test.ts` |
| MFA | TOTP (replay-protected), passkeys (user verification required); admins refused until MFA is verified in the session | `auth.int.test.ts`, `platform.int.test.ts` |
| SSO | OIDC (PKCE, state, nonce) and SAML 2.0 (signed assertions, audience, one-time RelayState, assertion replay cache); JIT provisioning only for verified domains; tenant-enforced SSO | `sso.int.test.ts` |
| Sessions | Opaque 256-bit tokens; only SHA-256 stored; HttpOnly, SameSite=Lax, Secure over HTTPS; idle and absolute timeouts per tenant; revoked on logout, password change and deprovisioning | `auth.int.test.ts` |
| Authorisation | Deny-by-default permission engine with scopes (entity, country, department, location, team, self), delegation and field-level access, shared by API and UI | `packages/core/test/permissions.test.ts` |
| Support access | Only through customer-granted, time-limited (≤30 days), revocable grants; read-only grants run read-only transactions; audited in the customer log and the staff trail | `platform.int.test.ts` |
| Audit | Append-only (no UPDATE or DELETE privilege, plus a trigger for every role); hash chain with verification; every mutating call audited (with a fallback hook); sensitive views audited | `packages/db/test/audit.int.test.ts`, `platform.int.test.ts` |
| Sensitive data | Envelope encryption (per-value data key, regional KMS key, AAD binding); category permissions; every decrypt audited; reporting role has no vault access | `platform.int.test.ts` |
| Transport and headers | TLS 1.2+ at the ALB; HSTS (preload); CSP; `frame-ancestors 'none'`; `nosniff`; strict referrer policy; `Cache-Control: private, no-store` on all API responses and authenticated pages | `auth.int.test.ts`, e2e |
| Logging | Shared logger and tracer scrub emails, phone numbers, NI numbers, SSNs, tokens and known personal fields; request bodies are never logged | `packages/core/test/core.test.ts` |
| Secrets | AWS Secrets Manager in AWS; git-ignored `.env` locally; secret scan in `pnpm verify`; GitHub OIDC for deploys (no long-lived keys) | `scripts/secret-scan.mjs`, `.github/workflows/deploy.yml` |
| Shared kiosks | Device token shown once, only its SHA-256 stored, revocable; employee number + Argon2id PIN; per-IP and per-kiosk throttles; lockout after N failures with identical answers and similar timing for unknown numbers; every attempt audited (ADR-0038) | `apps/api/test/time.int.test.ts`, `apps/web/e2e/kiosk.spec.ts` |
| Location data | Geofencing off by default, per country, only with worker notice; coordinates kept (4 dp) only when it applies, discarded otherwise, never logged or returned by the API (ADR-0037) | `apps/api/test/time.int.test.ts`, `apps/web/e2e/clock.spec.ts` |
| Public API credentials | API keys and OAuth client secrets and tokens are 256-bit random values; only SHA-256 hashes are stored; shown once; revocable; short-lived OAuth tokens; secret rotation with a grace period; permissions = role ∩ scopes; creators cannot exceed their own permissions; API clients cannot reach identity, settings or back-office routes; per-tenant rate limits; idempotency keys (ADR-0090, ADR-0091) | `apps/api/test/public-api.int.test.ts`, `packages/core/test/platform.test.ts` |
| Outbound calls (webhooks, SIEM) | https only; every resolved address checked at connect time against private, loopback, link-local, CGNAT and metadata ranges (DNS-rebinding safe); no redirects; bounded time and size; response bodies never stored; HMAC-SHA256 signatures with timestamp and rotation; KMS-sealed signing secrets; dev relaxations refused in production (ADR-0093, ADR-0094) | `apps/api/test/outbound.test.ts`, `apps/worker/test/webhooks.int.test.ts` |
| Sandboxes | Configuration only, from a classified allow-list; synthetic people; no credentials, SSO, webhooks or streams copied; same home region (ADR-0096) | `apps/api/test/sandbox.int.test.ts`, `apps/api/test/enterprise.residency.test.ts` |
| Branding | Accent accepted only within WCAG 2.2 AA contrast in both modes; hex-only CSS (no injection); logos content-sniffed (no SVG), served authenticated with `no-store` (ADR-0098) | `packages/ui/test/branding.test.ts`, `apps/api/test/tenant-platform.int.test.ts` |
| Billing provider boundary | Typed company-level inputs only (legal name, company address and tax id, PO number, primary billing contact, plan, prices, aggregate headcount, Thapsus ids); every payload inspected in tests; cards only on Stripe-hosted Checkout; test-mode keys only (`sk_test_`/`rk_test_`), from Secrets Manager per cell (ADR-0103) | `apps/api/test/billing.int.test.ts`, `apps/api/test/billing-stripe.test.ts` |
| Billing webhooks | Stripe signature verified on the raw body with the official SDK (5-minute tolerance); idempotent per event id; payloads reduced to ids, statuses, amounts and dates and never logged or stored; events for other regions ignored | `billing.int.test.ts`, `billing-stripe.test.ts`, `support-billing.residency.test.ts` |
| Support tickets and staff | Tickets under forced RLS in the home region; staff read a ticket only because the customer submitted it, and every view, reply and download is in the customer audit log and the staff trail; the cross-tenant queue is a metadata-only index; anything else needs a support grant (ADR-0101) | `apps/api/test/support.int.test.ts`, `apps/api/test/backoffice.int.test.ts` |
| Back office | Separate staff sessions (password + mandatory TOTP, cookie scoped to `/v1/backoffice`, SameSite=Strict); roles per screen; personal data only through `withSupportAccess` (no grant / expired / revoked → 403; read grants cannot write; both audit rows); append-only, exportable staff trail (ADR-0106) | `backoffice.int.test.ts`, `apps/web/e2e/backoffice.spec.ts` |
| Public status endpoint | The only edge-cacheable response (`public, max-age=30`): unauthenticated, rate-limited, no personal data; everything else stays `private, no-store` (ADR-0105) | `apps/api/test/status.int.test.ts` |
| Dependencies | Lockfile pinned; `pnpm audit --audit-level high` in verify and CI | verify `security` step |
| Infrastructure | WAF (AWS managed rules plus a rate limit) on every ALB; KMS everywhere; S3 public access blocked; no `*` action on `*` resource in IAM | `infra/test` |

## Accepted risks and follow-ups

- **CSP allows `'unsafe-inline'` scripts** because of Next.js inline bootstrap scripts. The fix is nonce-based CSP through Next middleware. That forces dynamic rendering, so it is scheduled for the Phase 12 hardening pass with a Lighthouse re-check.
- **Logger scrubbing is allow-list based for class instances.** Request and reply objects are reduced by serializers, and plain objects are scrubbed recursively. Code review rule: never log ORM or row objects directly.

## Reporting a vulnerability

Email security@{domain} (the domain is configured once it is chosen; see HUMAN_TODO.md). We acknowledge reports within 2 business days.
