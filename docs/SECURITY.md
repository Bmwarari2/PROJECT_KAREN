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
| Dependencies | Lockfile pinned; `pnpm audit --audit-level high` in verify and CI | verify `security` step |
| Infrastructure | WAF (AWS managed rules plus a rate limit) on every ALB; KMS everywhere; S3 public access blocked; no `*` action on `*` resource in IAM | `infra/test` |

## Accepted risks and follow-ups

- **CSP allows `'unsafe-inline'` scripts** because of Next.js inline bootstrap scripts. The fix is nonce-based CSP through Next middleware. That forces dynamic rendering, so it is scheduled for the Phase 12 hardening pass with a Lighthouse re-check.
- **Logger scrubbing is allow-list based for class instances.** Request and reply objects are reduced by serializers, and plain objects are scrubbed recursively. Code review rule: never log ORM or row objects directly.

## Reporting a vulnerability

Email security@{domain} (the domain is configured once it is chosen; see HUMAN_TODO.md). We acknowledge reports within 2 business days.
