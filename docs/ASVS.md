# OWASP ASVS level 2 review

PROGRESS 12.3. A requirement-by-requirement self-assessment of Thapsus-HR against **OWASP Application Security Verification Standard 5.0.0**, levels 1 and 2 (253 requirements; level 3 is out of scope). Source: the official ASVS 5.0.0 CSV (`OWASP_Application_Security_Verification_Standard_5.0.0_en.csv`, from https://github.com/OWASP/ASVS). Requirement texts below are shortened paraphrases; read the standard for the exact wording.

- **Reviewed:** 2026-10-19, on branch `phase-12-asvs` (all phases merged).
- **Scope:** the cell API (`apps/api`), worker (`apps/worker`), web app and marketing site (`apps/web`), back office, public API and SDK, SCIM, SSO, the CDK stacks (`infra/`) and CI. Out of scope: AWS itself (shared responsibility; "Met by platform" names the construct we rely on) and customer identity providers.
- **Method:** code reading, the automated tests cited as evidence (each named exactly as in the test file), and the infrastructure assertions in `infra/test`. Every "Met" points at code or a test; documentation-only requirements point at the section that satisfies them. Gaps are recorded with an owner in [SECURITY.md → Accepted risks and follow-ups](SECURITY.md#accepted-risks-and-follow-ups) or [HUMAN_TODO.md](HUMAN_TODO.md), and summarised in [ADR-0136](DECISIONS.md).
- **Decisions made in this review:** [ADR-0130](DECISIONS.md) to [ADR-0136](DECISIONS.md).
- **Not a substitute for** an independent penetration test ([HUMAN_TODO 5.2](HUMAN_TODO.md)).

## How to re-run the review

1. Run the evidence: `pnpm verify` (or at least `pnpm exec vitest run --project unit`, `--project integration`, `--project contract`, `--project isolation`, `--project residency`, and `pnpm --filter @thapsus/web exec playwright test --project=functional`). The ASVS-specific suites are `apps/api/test/asvs.int.test.ts`, `apps/api/test/asvs-units.test.ts`, `apps/api/test/mass-assignment.contract.test.ts`, `apps/web/test/csp.test.ts`, `apps/web/e2e/security-asvs.spec.ts`, `packages/db/test/tls.test.ts` and `scripts/test/sbom.test.ts`.
2. Download the current ASVS CSV and diff its requirement ids against the tables below; add rows for new requirements and re-check changed ones.
3. For each row, confirm the evidence still exists and still proves the requirement (renamed tests break the links). Re-check every "Gap" against SECURITY.md and HUMAN_TODO.md and promote it when it is closed.
4. Re-run the review after any new trust boundary, authentication pathway, upload feature, third party or cryptographic key, and before each production release.

## Summary

| Status | Level 1 | Level 2 | Total |
| --- | --- | --- | --- |
| Met | 47 | 98 | 145 |
| Met by platform | 2 | 4 | 6 |
| Fixed in this review | 12 | 35 | 47 |
| Not applicable | 7 | 33 | 40 |
| Gap (recorded) | 2 | 13 | 15 |
| **Total** | 70 | 183 | 253 |

Statuses: **Met** — implemented and proven by the evidence; **Met by platform** — provided by the AWS service named (configured by the CDK construct named); **Fixed in this review** — implemented or documented during this review, with tests; **Not applicable** — the feature does not exist in Thapsus-HR (reason given); **Gap** — not (fully) met, recorded with an owner.

### Gaps

| Requirement | Where it is recorded |
| --- | --- |
| V1.3.6 Protect against SSRF with allow-lists | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V3.5.4 Separate applications on separate host names | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V5.4.3 Scan untrusted files with antivirus | [HUMAN_TODO 1.7](HUMAN_TODO.md) |
| V6.3.3 MFA or combined factors required to access the application | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V6.4.1 Initial secrets random, expiring, not long-term | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V6.6.2 OOB requests bound to the original authentication request | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V6.8.1 Identity cannot be spoofed via another IdP | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V6.8.4 Verify IdP authentication strength (acr/amr) or document a fallback | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V10.5.2 User identified by non-reassignable claims (sub) | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V11.2.3 At least 128-bit security for all primitives | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V12.3.1 Encrypted protocols for all connections in and out | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V12.3.3 TLS between internal HTTP services | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V13.2.1 Backend authentication without static credentials | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V14.2.1 No sensitive data in URLs | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |
| V14.3.3 No sensitive data in browser storage (except session tokens) | [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) |

## V1 Encoding and Sanitization

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V1.1.1 | Decode input to canonical form once, before validation | L2 | Met | Fastify parses JSON/multipart once; TypeBox validates the parsed value; no later decoding. [`validation.ts`](../apps/api/src/http/validation.ts) |
| V1.1.2 | Encode output as the last step or by the interpreter | L2 | Met | React escapes all rendered text; SQL values go only as bind parameters; JSON via serializers. [`app.ts`](../apps/api/src/app.ts) |
| V1.2.1 | Context-aware output encoding (HTML, attributes, headers) | L1 | Met | React JSX escaping, no `dangerouslySetInnerHTML` anywhere in `apps/web`; header values built by helpers [`security.ts`](../apps/api/src/http/security.ts); [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("keeps plain ASCII names, and never lets a name break out of the header") |
| V1.2.2 | Encode untrusted data in URLs; only safe URL schemes | L1 | Met | `encodeURIComponent` / `URLSearchParams` for every built URL (e.g. sign-in links, SSO start); outbound URLs must be https [`outbound.test.ts`](../apps/api/test/outbound.test.ts) ("refuses non-https, credentials in the URL, literal private IPs and internal names") |
| V1.2.3 | Encode when building JavaScript/JSON | L1 | Met | JSON is produced by `JSON.stringify` / fast-json-stringify only; no script is built from data (nonce CSP blocks injected script) [`csp.test.ts`](../apps/web/test/csp.test.ts) |
| V1.2.4 | Parameterised database queries | L1 | Met | node-postgres bind parameters everywhere (`tx.query(sql, params)`); dynamic filters add `$n` placeholders; RLS as a second barrier [`rls.isolation.test.ts`](../packages/db/test/rls.isolation.test.ts) ("tenant A cannot select tenant B rows") |
| V1.2.5 | No OS command injection | L1 | Not applicable (the API, worker and web never start a child process; only build and dev scripts do) | No `child_process` use under `apps/*/src` or `packages/*/src` |
| V1.2.6 | No LDAP injection | L2 | Not applicable (no LDAP; directories integrate over SCIM, OIDC and SAML) | — |
| V1.2.7 | No XPath injection | L2 | Met | XPath runs only inside @node-saml/xml-crypto on fixed expressions; no XPath is built from input. [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("rejects tampered and replayed assertions") |
| V1.2.8 | Secure LaTeX processing | L2 | Not applicable (no LaTeX; PDFs are generated with pdf-lib) | — |
| V1.2.9 | Escape regex metacharacters in untrusted input | L2 | Met | No input is concatenated into a regex; `LIKE` patterns escape `\ % _` (`/v1/users` search). Admin-defined patterns (payslip file names, custom-field validation) are deliberate features, length-limited (200). [`matching.ts`](../apps/api/src/modules/payslips/matching.ts) |
| V1.3.1 | Sanitise WYSIWYG/HTML input with a known library | L1 | Not applicable (no rich-text or HTML input is accepted or rendered; all text is rendered escaped) | No `dangerouslySetInnerHTML`; templates are plain text with `{{merge}}` fields |
| V1.3.2 | No eval() or dynamic code execution | L1 | Met | No `eval` / `new Function` in application code; production CSP has no `unsafe-eval` [`csp.test.ts`](../apps/web/test/csp.test.ts) ("only development adds unsafe-eval (React debugging), never production") |
| V1.3.3 | Sanitise data passed to dangerous contexts | L2 | Met | Spreadsheet formula prefixes neutralised in CSV/XLSX exports (T15); file names sanitised for headers [`corehr-flows.int.test.ts`](../apps/api/test/corehr-flows.int.test.ts); [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("keeps plain ASCII names, and never lets a name break out of the header") |
| V1.3.4 | Sanitise user-supplied SVG | L2 | Met | SVG uploads are refused (logos are content-sniffed PNG/JPEG/WebP only) [`tenant-platform.int.test.ts`](../apps/api/test/tenant-platform.int.test.ts) ("stores the logo in the home-region object store under the tenant prefix and serves it to signed-in users only") |
| V1.3.5 | Sanitise scriptable template content (Markdown, CSS, XSL) | L2 | Met | Markdown documents are stored and downloaded as attachments, never rendered; branding accepts hex colours only [`branding.test.ts`](../packages/ui/test/branding.test.ts) |
| V1.3.6 | Protect against SSRF with allow-lists | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | Webhooks and SIEM streams check every resolved address at connect time [`outbound.test.ts`](../apps/api/test/outbound.test.ts) ("blocks at connect time when DNS resolves a public-looking name to a private address (rebinding)"); automation webhooks and the `http` integration check the host name only (no DNS check yet) |
| V1.3.7 | No template injection from untrusted input | L2 | Met | Document templates only substitute named `{{field}}` values; no template engine evaluates input [`corehr-flows.int.test.ts`](../apps/api/test/corehr-flows.int.test.ts) ("renders templates with merge fields, collects a click-to-sign signature with a verifiable audit trail") |
| V1.3.8 | Sanitise JNDI queries | L2 | Not applicable (no Java / JNDI) | — |
| V1.3.9 | Sanitise content sent to memcache | L2 | Met | Valkey is used through ioredis commands with typed arguments (rate-limit keys); no text protocol is built [`rate-limit.ts`](../apps/api/src/lib/rate-limit.ts) |
| V1.3.10 | Sanitise format strings | L2 | Met | Message catalogues interpolate named `{placeholders}` from code-supplied values only; no printf-style formatting of input [`catalogues.ts`](../packages/core/src/i18n/catalogues.ts) |
| V1.3.11 | Prevent SMTP/IMAP injection | L2 | Met | Mail goes through the SES API (structured fields) or nodemailer locally; recipients are validated emails, subjects come from the catalogues [`mailer.ts`](../apps/api/src/lib/mailer.ts) |
| V1.4.1 | Memory-safe string handling | L2 | Not applicable (managed runtime (Node.js / TypeScript); no unmanaged code of our own) | — |
| V1.4.2 | Prevent integer overflows | L2 | Met | Money is integer minor units as `bigint`; database `bigint`/`numeric` returned as strings; TypeBox ranges on integers [`money.ts`](../packages/core/src/money.ts) |
| V1.4.3 | Release memory, no dangling pointers | L2 | Not applicable (garbage-collected runtime) | — |
| V1.5.1 | XML parsers restrictive (no XXE) | L1 | Met | SAML XML is parsed by @xmldom/xmldom inside @node-saml (no external entity resolution); XLSX by ExcelJS (no DTDs) [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("rejects tampered and replayed assertions") |
| V1.5.2 | Safe deserialisation of untrusted data | L2 | Met | Only JSON (secure-json-parse rejects `__proto__`) and multipart are accepted [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("refuses prototype-pollution keys in JSON bodies") |

## V2 Validation and Business Logic

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V2.1.1 | Document input validation rules | L1 | Met | Every route declares a TypeBox schema, published as OpenAPI 3.1 (`packages/sdk/openapi.json`) [`openapi.contract.test.ts`](../apps/api/test/openapi.contract.test.ts) |
| V2.1.2 | Document combined-data consistency rules | L2 | Met | Effective-dating rules (ADR-0007), jurisdiction packs with sources (`packages/rules`), import validation (ADR-0019) [`DECISIONS.md`](../docs/DECISIONS.md) |
| V2.1.3 | Document business-logic limits per user and globally | L2 | Met | Rate limits and quotas: [SECURITY.md → Authentication pathways](SECURITY.md#authentication-pathways), `docs/api.md` (per-plan API limits), `docs/PERFORMANCE.md` (row caps, timeouts) |
| V2.2.1 | Positive validation of all input | L1 | Met | TypeBox schemas (formats, patterns, enums, ranges) on every route; bodies cleaned of undeclared fields [`mass-assignment.contract.test.ts`](../apps/api/test/mass-assignment.contract.test.ts) ("every route body removes or refuses a field it does not declare") |
| V2.2.2 | Validate at a trusted service layer | L1 | Met | The API validates every request; the web client only mirrors hints [`validation.ts`](../apps/api/src/http/validation.ts) |
| V2.2.3 | Combinations of related items are reasonable | L2 | Met | Exclusion constraints on effective-dated rows, date-range and currency checks [`employees.int.test.ts`](../apps/api/test/employees.int.test.ts) ("overlapping periods are rejected by the database") |
| V2.3.1 | Business flows in order, no skipped steps | L1 | Met | Second factor before anything else; approval chains and signature workflows are state machines [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("a non-admin with an authenticator must use it after a password sign-in"); [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("admin routes are refused until a second factor is enrolled and verified") |
| V2.3.2 | Business-logic limits implemented as documented | L2 | Met | Throttles, lockout, row caps and plan limits enforced in code [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("rate-limits sign-in attempts per account and per IP"); [`public-api.int.test.ts`](../apps/api/test/public-api.int.test.ts) ("returns 429 with Retry-After and RateLimit headers once the tenant limit is used up; other tenants are unaffected") |
| V2.3.3 | Transactions: all or nothing | L2 | Met | Every tenant operation runs in one `withTenant` transaction; audit and outbox rows in the same transaction [`foundation.int.test.ts`](../apps/api/test/foundation.int.test.ts) ("the safety-net hook audits a mutating call whose route forgot to") |
| V2.3.4 | Locking prevents double booking of limited resources | L2 | Met | `SELECT … FOR UPDATE` on shift claims, approvals, owner revocation and sessions (36 call sites); idempotency keys [`public-api.int.test.ts`](../apps/api/test/public-api.int.test.ts) ("replay the stored response for the same key and body, refuse a different body, and are scoped per caller") |
| V2.4.1 | Anti-automation against excessive calls | L2 | Met | Per-IP, per-account and per-tenant limits plus the WAF rate rule [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("rate-limits sign-in attempts per account and per IP"); [`infra.test.ts`](../infra/test/infra.test.ts) ("3. every ALB has a WAF web ACL association; HTTPS is TLS 1.2+ and HTTP only redirects") |

## V3 Web Frontend Security

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V3.2.1 | Prevent rendering in the wrong context (Sec-Fetch, CSP sandbox, attachment) | L1 | Met | API responses carry `default-src 'none'` CSP and `nosniff`; files are downloaded as attachments with `Content-Disposition` [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("sends non-ASCII names as RFC 8187 filename* with an ASCII fallback") |
| V3.2.2 | Render text with safe functions (textContent) | L1 | Met | All UI text is rendered by React (escaped); no `innerHTML` use in `apps/web` or `packages/ui` |
| V3.3.1 | Cookies Secure with __Host- or __Secure- prefix | L1 | Fixed in this review | `__Host-thr_sid`, `__Host-thr_staff`, `__Host-thr_sso` behind HTTPS [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("over HTTPS the session cookie is __Host-thr_sid: Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain"); [ADR-0130](DECISIONS.md) |
| V3.3.2 | SameSite set according to purpose | L2 | Met | Session Lax (IdP and emailed-link navigations), staff Strict, SSO binding Lax; cross-site requests are also refused by origin [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("refuses state-changing requests from another origin, with or without the session cookie") |
| V3.3.3 | __Host- prefix unless shared with other hosts | L2 | Fixed in this review | Same as V3.3.1; no cookie sets a Domain [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("the back-office staff cookie is __Host-thr_staff over HTTPS") |
| V3.3.4 | HttpOnly for tokens; only via Set-Cookie | L2 | Met | Session, staff and SSO cookies are HttpOnly; tokens never appear in response bodies for browser sessions [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("over HTTPS the session cookie is __Host-thr_sid: Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain") |
| V3.4.1 | HSTS ≥ 1 year, includeSubDomains | L1 | Met | `max-age=63072000; includeSubDomains; preload` on web (`next.config.ts`) and API (helmet) [`foundation.spec.ts`](../apps/web/e2e/foundation.spec.ts) ("owner signs up in the UK region, must enrol MFA, then reaches the app") |
| V3.4.2 | CORS origin fixed or allow-listed | L1 | Met | CORS allows only the app and global origins with credentials [`app.ts`](../apps/api/src/app.ts) |
| V3.4.3 | CSP with object-src 'none', base-uri 'none' and nonces or an allow-list | L2 | Fixed in this review | Per-request nonce, `strict-dynamic`, no inline scripts, `base-uri 'none'` [`csp.test.ts`](../apps/web/test/csp.test.ts) ("pages allow only nonce-carrying scripts (and what they load), no plugins, no base rewrite, no framing"); [`security-asvs.spec.ts`](../apps/web/e2e/security-asvs.spec.ts) ("every page gets a fresh nonce policy and still runs: no inline script is allowed, nothing is blocked") |
| V3.4.4 | X-Content-Type-Options: nosniff on all responses | L2 | Met | helmet (API) and `next.config.ts` (web, every path) [`foundation.spec.ts`](../apps/web/e2e/foundation.spec.ts) ("owner signs up in the UK region, must enrol MFA, then reaches the app") |
| V3.4.5 | Referrer policy prevents leaking sensitive data | L2 | Met | Web `strict-origin-when-cross-origin`, API `no-referrer` (helmet); emailed tokens are removed from the address bar at once [`next.config.ts`](../apps/web/next.config.ts) |
| V3.4.6 | CSP frame-ancestors on every response | L2 | Met | `frame-ancestors 'none'` on pages (proxy), static assets (`next.config.ts`) and the API (helmet) [`csp.test.ts`](../apps/web/test/csp.test.ts) ("static assets get a policy under which nothing runs or frames, and pages are covered by the proxy") |
| V3.5.1 | Validate origin of non-preflighted sensitive requests (CSRF) | L1 | Fixed in this review | Origin / Sec-Fetch-Site checked on every state-changing request; the SAML ACS is the documented exception [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("refuses state-changing requests from another origin, with or without the session cookie"); [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("the SAML ACS is the one route that accepts a cross-site form post (by design; the assertion protects it)") |
| V3.5.2 | Sensitive functions not callable without preflight | L1 | Fixed in this review | text/plain and urlencoded bodies are not parsed (except SAML ACS and OAuth token) [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("only JSON (or multipart on upload routes) is parsed: CORS-safelisted text and form bodies are refused") |
| V3.5.3 | Sensitive functionality uses unsafe HTTP methods | L1 | Met | Every change is POST/PUT/PATCH/DELETE; GET routes only read (viewing a payslip records the view) [`openapi.contract.test.ts`](../apps/api/test/openapi.contract.test.ts) |
| V3.5.4 | Separate applications on separate host names | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | `app.<cell>`, `api.<cell>` and `www` are separate; the back office is still served under `/backoffice` on the app host |
| V3.5.5 | Discard untrusted postMessage messages | L2 | Not applicable (the app neither sends nor receives postMessage) | No `postMessage` / `message` listeners in `apps/web` or `packages/ui` |
| V3.7.1 | Only supported, secure client-side technologies | L2 | Met | React 19 / Next.js 16, a service worker and WebAuthn; no plugins (`object-src 'none'`) [`csp.test.ts`](../apps/web/test/csp.test.ts) |
| V3.7.2 | Redirect off-site only to allow-listed destinations | L2 | Met | Redirects go to configured regional app URLs or the customer's configured IdP; no redirect target is taken from a parameter [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("refuses to create a tenant for another region in this cell and points to the right one") |

## V4 API and Web Service

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V4.1.1 | Content-Type with charset on every body | L1 | Fixed in this review | Fastify sets JSON/text charsets; an onSend hook adds `charset=utf-8` to any text or XML type (SAML metadata, dev HTML) [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("text and XML responses declare a charset; JSON keeps application/json"); [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("adds charset=utf-8 to text and XML types, leaves JSON, binary and explicit charsets alone") |
| V4.1.2 | Only user-facing endpoints redirect HTTP→HTTPS | L2 | Fixed in this review | Port 80 redirects pages; API, SCIM, OpenAPI and health paths get a 400 problem [`infra.test.ts`](../infra/test/infra.test.ts) ("3. every ALB has a WAF web ACL association; HTTPS is TLS 1.2+ and HTTP only redirects") |
| V4.1.3 | Intermediary-set headers cannot be overridden by users | L2 | Met | Only the first private hop is trusted; the web proxy drops client forwarding headers [`proxy-trust.test.ts`](../apps/api/test/proxy-trust.test.ts) ("uses the address the trusted proxy appended, never one the client supplied"); [`foundation.int.test.ts`](../apps/api/test/foundation.int.test.ts) ("a client cannot choose its own IP: only the hop added by the trusted proxy counts") |
| V4.2.1 | Consistent HTTP message boundaries (no smuggling) | L2 | Met by platform (AWS, `ApplicationLoadBalancer dropInvalidHeaderFields + desync mitigation; Node.js strict llhttp`) | [`shared.ts`](../infra/lib/shared.ts) (`publicAlb`) |
| V4.3.1 | GraphQL query limits | L2 | Not applicable (no GraphQL) | — |
| V4.3.2 | GraphQL introspection off in production | L2 | Not applicable (no GraphQL) | — |
| V4.4.1 | WebSockets over TLS | L1 | Not applicable (no WebSockets) | — |
| V4.4.2 | WebSocket Origin check | L2 | Not applicable (no WebSockets) | — |
| V4.4.3 | Dedicated WebSocket tokens | L2 | Not applicable (no WebSockets) | — |
| V4.4.4 | WebSocket tokens from the authenticated session | L2 | Not applicable (no WebSockets) | — |

## V5 File Handling

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V5.1.1 | Document permitted types, extensions, sizes (incl. unpacked) and safety | L2 | Fixed in this review | [SECURITY.md → File handling](SECURITY.md#file-handling) |
| V5.2.1 | Accept only files of a processable size | L1 | Met | Per-route multipart limits, 25 MB documents, 200 MB per payslip request [`corehr-flows.int.test.ts`](../apps/api/test/corehr-flows.int.test.ts) ("validates uploads by type, size and content"); [`routes.ts`](../apps/api/src/modules/payslips/routes.ts) |
| V5.2.2 | Check extension and content (magic bytes) for every file | L1 | Fixed in this review | Magic bytes for every upload route (shared `lib/file-types.ts`), document names must match the type, zip entries must be PDFs [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("a document must be named like its type (an .exe cannot be filed as a PDF)"); [`corehr-flows.int.test.ts`](../apps/api/test/corehr-flows.int.test.ts) ("validates uploads by type, size and content") |
| V5.2.3 | Check compressed files for unpacked size and file count before unpacking | L2 | Fixed in this review | Entry count from the end-of-central-directory before parsing; inflated bytes counted [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("reads the entry count from the end-of-central-directory record before anything is inflated"); [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("stops inflating at the per-entry limit even when the archive declares a tiny size"); [ADR-0133](DECISIONS.md) |
| V5.3.1 | Uploaded files in public folders are never executed | L1 | Met | Files live in a private, versioned S3 bucket (public access blocked), served only as attachments through presigned URLs [`infra.test.ts`](../infra/test/infra.test.ts) ("2. buckets block all public access and are encrypted; the files bucket is versioned SSE-KMS and region-named") |
| V5.3.2 | File paths from internal data, not user file names | L1 | Met | Object keys are `<tenant>/<area>/<uuid><ext>` (`objectKey`); user names are metadata only [`object-store.ts`](../apps/api/src/lib/object-store.ts) |
| V5.4.1 | Validate or ignore user file names; set Content-Disposition filename | L2 | Met | Names are sanitised on upload (support) and in every Content-Disposition [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("keeps plain ASCII names, and never lets a name break out of the header") |
| V5.4.2 | Encode served file names (RFC 6266) | L2 | Fixed in this review | `contentDisposition()` for S3 presigned downloads, exports and dev downloads [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("sends non-ASCII names as RFC 8187 filename* with an ASCII fallback") |
| V5.4.3 | Scan untrusted files with antivirus | L2 | Gap — recorded in [HUMAN_TODO 1.7](HUMAN_TODO.md) | GuardDuty Malware Protection for S3 is recurring cost; [ADR-0136](DECISIONS.md) |

## V6 Authentication

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V6.1.1 | Document rate limiting, anti-automation and lockout (and malicious lockout) | L1 | Fixed in this review | [SECURITY.md → Authentication pathways](SECURITY.md#authentication-pathways) |
| V6.1.2 | Document context-specific words for passwords | L2 | Fixed in this review | [SECURITY.md → Passwords](SECURITY.md#passwords) |
| V6.1.3 | Document every authentication pathway and its strength | L2 | Fixed in this review | [SECURITY.md → Authentication pathways](SECURITY.md#authentication-pathways) |
| V6.2.1 | Passwords at least 8 characters (15 recommended) | L1 | Met | Minimum 12 [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("permits any composition and length from 12 to 128 characters, counting characters not bytes"); [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("rejects duplicate slugs and weak passwords") |
| V6.2.2 | Users can change their password | L1 | Fixed in this review | `POST /v1/auth/password` and the Security page (new) [`security-asvs.spec.ts`](../apps/web/e2e/security-asvs.spec.ts) ("people see where they are signed in, re-authenticate when the sign-in is old, and sign other sessions out") |
| V6.2.3 | Password change requires current and new password | L1 | Met | [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("password change needs the current password, applies the policy, keeps this session and ends the others") |
| V6.2.4 | Check against the top 3,000+ passwords of the policy length | L1 | Fixed in this review | 10,000 most common 12–128-character passwords, bundled [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("bundles at least the top 3,000 common passwords of the allowed length (offline)"); [ADR-0132](DECISIONS.md) |
| V6.2.5 | No composition rules | L1 | Met | [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("permits any composition and length from 12 to 128 characters, counting characters not bytes") |
| V6.2.6 | Password fields use type=password | L1 | Met | `type="password"` on every password field: `apps/web/app/(auth)/signin/form.tsx`, `apps/web/app/(auth)/signup/form.tsx`, `apps/web/app/app/security/page.tsx`, `apps/web/app/app/step-up.tsx`, `apps/web/app/backoffice/signin/page.tsx` |
| V6.2.7 | Paste and password managers permitted | L1 | Met | No paste blocking; `autocomplete=current-password/new-password` on every field (`apps/web/app/(auth)/signin/form.tsx`, `apps/web/app/app/security/page.tsx`) |
| V6.2.8 | Verify the password exactly as received | L1 | Met | No trimming, truncation or case change before Argon2id (`apps/api/src/modules/auth/routes.ts` login, `tokens.ts`) |
| V6.2.9 | Passwords of at least 64 characters permitted | L2 | Met | Up to 128 characters (Unicode counted as characters) [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("allows long passphrases of any characters and refuses common and context-specific passwords at sign-up") |
| V6.2.10 | No periodic rotation | L2 | Met | Passwords never expire ([SECURITY.md → Passwords](SECURITY.md#passwords)) |
| V6.2.11 | Use the context-specific word list | L2 | Fixed in this review | [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("refuses context-specific words: product, company, workspace, the person’s name and email"); [`security-asvs.spec.ts`](../apps/web/e2e/security-asvs.spec.ts) ("people see where they are signed in, re-authenticate when the sign-in is old, and sign other sessions out") |
| V6.2.12 | Check against breached passwords | L2 | Fixed in this review | The bundled list is drawn from public breach compilations (offline; no third-party breach API, [ADR-0132](DECISIONS.md)) [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("allows long passphrases of any characters and refuses common and context-specific passwords at sign-up") |
| V6.3.1 | Credential stuffing and brute force controls as documented | L1 | Met | [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("locks the account after repeated failures"); [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("rate-limits sign-in attempts per account and per IP"); [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("does not reveal whether an account exists") |
| V6.3.2 | No default accounts | L1 | Met | Accounts exist only through sign-up, invitation, SCIM, JIT SSO or the staff CLI (random password); the demo seed runs only locally [`foundation.int.test.ts`](../apps/api/test/foundation.int.test.ts) ("every new tenant gets exactly the built-in roles from the brief") |
| V6.3.3 | MFA or combined factors required to access the application | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | Admins must use MFA and, since this review, anyone who has a factor must use it [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("a non-admin with an authenticator must use it after a password sign-in"); [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("anyone with a factor must use it; admins must enrol one; others without a factor pass"). Employees without a factor may still sign in with a password alone unless the customer enforces SSO (documented rationale and mitigations in SECURITY.md) |
| V6.3.4 | No undocumented pathways; consistent strength | L2 | Fixed in this review | [SECURITY.md → Authentication pathways](SECURITY.md#authentication-pathways); the second-factor gate applies to every path [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("an emailed sign-in link (the forgotten-password route) still requires the second factor") |
| V6.4.1 | Initial secrets random, expiring, not long-term | L1 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | Invitations and emailed links are 256-bit, single-use, expiring [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("expires after 10 minutes (ASVS V6.5.5)"); the generated first password of a staff account is not forced to change |
| V6.4.2 | No password hints or secret questions | L1 | Met | None exist |
| V6.4.3 | Password reset does not bypass MFA | L2 | Fixed in this review | The forgotten-password route is an emailed sign-in link, after which the second factor is required [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("an emailed sign-in link (the forgotten-password route) still requires the second factor") |
| V6.4.4 | Lost factor: identity proofing at enrolment level | L2 | Fixed in this review | Admin reset after out-of-band identity confirmation, audited, emailed; a sole owner is a recorded follow-up [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("an admin who holds everything the person holds resets their factors after confirming identity; the person is signed out and told"); [ADR-0131](DECISIONS.md) |
| V6.5.1 | Lookup secrets, OOB codes and TOTPs usable once | L2 | Fixed in this review | Tenant TOTP steps once (existing); staff TOTP steps once (new); emailed links single-use [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("a TOTP code cannot be replayed"); [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("emails a single-use link that signs the user in") |
| V6.5.2 | Low-entropy lookup secrets hashed with a salted slow hash | L2 | Not applicable (no lookup secrets (recovery codes); every stored token has 256 bits and is SHA-256 hashed) | [`tokens.ts`](../apps/api/src/modules/auth/tokens.ts) |
| V6.5.3 | Secrets and TOTP seeds from a CSPRNG | L2 | Met | `crypto.randomBytes` tokens; TOTP seeds from `OTPAuth.Secret` (Web Crypto) [`tokens.ts`](../apps/api/src/modules/auth/tokens.ts), [`routes.ts`](../apps/api/src/modules/auth/routes.ts) |
| V6.5.4 | OOB codes and lookup secrets ≥ 20 bits of entropy | L2 | Met | Emailed tokens have 256 bits; TOTP is 6 digits [`tokens.ts`](../apps/api/src/modules/auth/tokens.ts) |
| V6.5.5 | OOB tokens ≤ 10 minutes; TOTP ≤ 30 seconds | L2 | Fixed in this review | Emailed links now 10 minutes; TOTP 30-second steps, ±1 step drift [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("expires after 10 minutes (ASVS V6.5.5)") |
| V6.6.1 | SMS/phone OTP only with validated numbers and alternatives | L2 | Not applicable (no SMS or phone factors) | — |
| V6.6.2 | OOB requests bound to the original authentication request | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | Emailed links are single-use and short-lived but work on another device by design |
| V6.6.3 | OOB codes rate-limited | L2 | Met | Requests 3 per account / 20 per IP per 15 minutes; consumption 30 per IP; 256-bit tokens [`routes.ts`](../apps/api/src/modules/auth/routes.ts) |
| V6.8.1 | Identity cannot be spoofed via another IdP | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | Users are linked by email within the tenant, not by issuer + subject |
| V6.8.2 | Signatures on assertions always validated | L2 | Met | SAML assertions must be signed (`wantAssertionsSigned`), SHA-2 only; OIDC ID tokens verified by openid-client [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("rejects tampered and replayed assertions") |
| V6.8.3 | SAML assertions processed once | L2 | Met | Assertion ID replay cache [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("rejects tampered and replayed assertions") |
| V6.8.4 | Verify IdP authentication strength (acr/amr) or document a fallback | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | "Trust IdP MFA" tenant setting (default on) does not check `amr` |

## V7 Session Management

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V7.1.1 | Document timeouts with NIST 800-63B justification | L2 | Fixed in this review | [SECURITY.md → Sessions](SECURITY.md#sessions) |
| V7.1.2 | Document concurrent session policy | L2 | Fixed in this review | [SECURITY.md → Sessions](SECURITY.md#sessions) |
| V7.1.3 | Document federated session coordination | L2 | Fixed in this review | [SECURITY.md → Sessions](SECURITY.md#sessions) |
| V7.2.1 | Session tokens verified by a trusted backend | L1 | Met | Opaque tokens looked up (hashed) in the tenant database on every request [`sessions.ts`](../apps/api/src/modules/auth/sessions.ts) |
| V7.2.2 | Dynamically generated session tokens | L1 | Met | [`sessions.ts`](../apps/api/src/modules/auth/sessions.ts) (`createSession`) |
| V7.2.3 | Reference tokens from a CSPRNG with ≥ 128 bits | L1 | Met | 256-bit `randomBytes` [`tokens.ts`](../apps/api/src/modules/auth/tokens.ts) |
| V7.2.4 | New token on authentication and re-authentication; old one ends | L1 | Fixed in this review | [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("signing in again from the same browser ends the session it held before"); [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("people list their sessions and, after re-authenticating, end one or all of the others") |
| V7.3.1 | Inactivity timeout | L2 | Met | Default 30 minutes per tenant; staff 30 minutes (new) [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("expires after the idle timeout") |
| V7.3.2 | Absolute session lifetime | L2 | Met | [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("expires at the absolute timeout even when active, and both are configurable per tenant") |
| V7.4.1 | Terminated sessions cannot be used | L1 | Met | [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("logout revokes the session"); [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("logout clears the cookie with the same attributes and sends Clear-Site-Data") |
| V7.4.2 | All sessions end when an account is disabled | L1 | Met | SCIM deactivation revokes sessions and every request re-checks the account status [`scim.int.test.ts`](../apps/api/test/scim.int.test.ts) ("patches with path and without path (Entra style), and deactivation revokes access") |
| V7.4.3 | Option to end other sessions after a factor change | L2 | Fixed in this review | Password, TOTP and passkey changes end every other session [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("adding an authenticator ends the other sessions; changing it needs a recent re-authentication"); [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("password change needs the current password, applies the policy, keeps this session and ends the others") |
| V7.4.4 | Visible logout on every authenticated page | L2 | Met | Sign-out button in the app top bar [`foundation.spec.ts`](../apps/web/e2e/foundation.spec.ts) ("owner signs up in the UK region, must enrol MFA, then reaches the app") |
| V7.4.5 | Admins can end sessions for one user or all users | L2 | Fixed in this review | [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("company-wide admins sign one person out everywhere, or everyone") |
| V7.5.1 | Full re-authentication before changing authentication attributes | L2 | Fixed in this review | Factor changes, first passwords and session ends need a sign-in or re-authentication within 10 minutes; emails cannot be changed by the person [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("adding an authenticator ends the other sessions; changing it needs a recent re-authentication") |
| V7.5.2 | Users view and end their sessions (after re-authenticating) | L2 | Fixed in this review | [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("people list their sessions and, after re-authenticating, end one or all of the others"); [`security-asvs.spec.ts`](../apps/web/e2e/security-asvs.spec.ts) ("people see where they are signed in, re-authenticate when the sign-in is old, and sign other sessions out") |
| V7.6.1 | RP/IdP session lifetimes behave as documented | L2 | Met | Our session lifetimes apply to SSO sessions as documented in [SECURITY.md → Sessions](SECURITY.md#sessions) [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("signs in end to end and just-in-time provisions users from a verified domain") |
| V7.6.2 | Session creation needs consent or explicit action | L2 | Met | SSO starts only from a user action; no IdP-initiated SAML (RelayState required) or silent OIDC [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("only the browser that started the sign-in can finish it (no login CSRF), and failures are audited") |

## V8 Authorization

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V8.1.1 | Document function- and data-level access rules | L1 | Met | ADR-0120 to ADR-0123, ADR-0015, the permission catalogue (`packages/core/src/access.ts`, `roles.ts`) |
| V8.1.2 | Document field-level access rules | L2 | Met | Field catalogue and field-access levels (ADR-0120) [`roles.int.test.ts`](../apps/api/test/roles.int.test.ts) ("serves the permission and field catalogue, which covers every employee field the API checks") |
| V8.2.1 | Function-level access needs explicit permission | L1 | Met | [`permissions.test.ts`](../packages/core/test/permissions.test.ts) ("denies by default"); [`roles.int.test.ts`](../apps/api/test/roles.int.test.ts) ("a change applies to the person’s very next request: grant, edit and revoke") |
| V8.2.2 | Data-level access (no IDOR/BOLA) | L1 | Met | Scopes (entity, country, department, location, team, self) on every record [`permissions.test.ts`](../packages/core/test/permissions.test.ts) ("manager scope covers the whole reporting chain below them but not other teams"); [`employees.int.test.ts`](../apps/api/test/employees.int.test.ts) ("entity-scoped HR admins only see and change their entity") |
| V8.2.3 | Field-level access (no BOPLA) | L2 | Met | [`permissions.test.ts`](../packages/core/test/permissions.test.ts) ("custom roles with field-level permissions: most specific key wins, highest grant wins"); [`employees.int.test.ts`](../apps/api/test/employees.int.test.ts) ("managers see their team with limited fields and cannot see pay; employees see themselves") |
| V8.3.1 | Authorisation enforced server-side | L1 | Met | The API checks every route; the UI uses the same engine only to hide controls [`permissions.test.ts`](../packages/core/test/permissions.test.ts) |
| V8.4.1 | Cross-tenant controls | L2 | Met | Forced RLS on every tenant table, non-owner app role [`rls.isolation.test.ts`](../packages/db/test/rls.isolation.test.ts) ("every table in tenant schemas has tenant_id, forced RLS, the tenant policy and a tenant-leading index"); [`rls.isolation.test.ts`](../packages/db/test/rls.isolation.test.ts) ("tenant A cannot update or delete tenant B rows") |

## V9 Self-contained Tokens

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V9.1.1 | Self-contained tokens validated by signature/MAC | L1 | Met | We issue no self-contained tokens; the OIDC ID tokens we accept are verified by openid-client against the issuer's keys [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("signs in end to end and just-in-time provisions users from a verified domain") |
| V9.1.2 | Algorithm allow-list, no "none" | L1 | Met | openid-client (oauth4webapi) verifies ID token signatures with the issuer's published keys and rejects unsigned (`none`) tokens; we issue no JWTs [`sso.ts`](../apps/api/src/modules/auth/sso.ts) |
| V9.1.3 | Keys from trusted pre-configured sources (no jku/x5u) | L1 | Met | Keys come only from the configured issuer's discovery document; embedded `jku`/`x5u`/`jwk` headers are ignored by openid-client [`sso.ts`](../apps/api/src/modules/auth/sso.ts) |
| V9.2.1 | nbf/exp verified | L1 | Met | openid-client checks `exp`, `iat` and `nbf` (library) [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("signs in end to end and just-in-time provisions users from a verified domain") |
| V9.2.2 | Token type and purpose verified | L2 | Met | Only ID tokens prove sign-in; our API accepts only its own opaque session, API-key and access tokens, each by prefix [`api-auth.ts`](../apps/api/src/modules/platform/api-auth.ts) |
| V9.2.3 | Audience verified | L2 | Met | ID token `aud` must equal the connection's client id (openid-client) [`sso.ts`](../apps/api/src/modules/auth/sso.ts) |
| V9.2.4 | Audience-restricted tokens when one key serves many audiences | L2 | Not applicable (we issue no signed tokens) | — |

## V10 OAuth and OIDC

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V10.1.1 | Tokens only sent to components that need them | L2 | Met | IdP tokens stay in the API (backend-for-frontend); the browser holds only the session cookie [`sso.ts`](../apps/api/src/modules/auth/sso.ts) |
| V10.1.2 | Authorization responses bound to the user-agent session and transaction | L2 | Fixed in this review | PKCE verifier, state and nonce per transaction, bound to the starting browser by `__Host-thr_sso`; integration OAuth state is bound to the user [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("only the browser that started the sign-in can finish it (no login CSRF), and failures are audited") |
| V10.2.1 | Code flow CSRF protection (PKCE or state) | L2 | Met | PKCE S256 and state [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("refuses users from unverified domains (no JIT) and replayed state") |
| V10.2.2 | Mix-up defence with several authorization servers | L2 | Met | State identifies the connection whose issuer is used; openid-client validates `iss` in the response (RFC 9207) [`sso.ts`](../apps/api/src/modules/auth/sso.ts) |
| V10.3.1 | Resource server accepts only tokens meant for it | L2 | Met | Access tokens are opaque references stored in this tenant's database; tokens from elsewhere cannot resolve [`public-api.int.test.ts`](../apps/api/test/public-api.int.test.ts) ("issues short-lived bearer tokens limited to the requested scopes; rotation keeps the old secret for the grace period") |
| V10.3.2 | Authorisation from token claims (scope) | L2 | Met | Effective permissions = client role ∩ granted scopes [`public-api.int.test.ts`](../apps/api/test/public-api.int.test.ts) ("get the intersection of the role and the scopes") |
| V10.3.3 | User identified from non-reassignable claims | L2 | Met | A token maps to the OAuth client id (UUID), never a reusable name [`api-auth.ts`](../apps/api/src/modules/platform/api-auth.ts) |
| V10.3.4 | Authentication strength in access tokens checked | L2 | Not applicable (client-credentials tokens represent a machine client, not a person) | — |
| V10.4.1 | Redirect URIs exact-match allow-list | L1 | Not applicable (only the client-credentials grant is offered; no redirects) | [`oauth.ts`](../apps/api/src/modules/platform/oauth.ts) |
| V10.4.2 | Authorization codes single use | L1 | Not applicable (no authorization code grant) | — |
| V10.4.3 | Authorization codes short-lived | L1 | Not applicable (no authorization code grant) | — |
| V10.4.4 | Only the grants a client needs; no implicit or password grant | L1 | Met | Client credentials only; anything else is `unsupported_grant_type` [`openapi.contract.test.ts`](../apps/api/test/openapi.contract.test.ts) |
| V10.4.5 | Refresh token replay mitigated for public clients | L1 | Not applicable (no refresh tokens and no public clients) | — |
| V10.4.6 | PKCE required (no plain) for code grant | L2 | Not applicable (no authorization code grant) | — |
| V10.4.7 | Unauthenticated dynamic client registration mitigated | L2 | Not applicable (no dynamic registration; admins create clients) | — |
| V10.4.8 | Refresh tokens have an absolute expiry | L2 | Not applicable (no refresh tokens) | — |
| V10.4.9 | Users can revoke tokens in the UI | L2 | Met | Revoking a client (Settings → API access) invalidates all its tokens at once [`public-api.int.test.ts`](../apps/api/test/public-api.int.test.ts) ("turning the public API off refuses keys and token requests") |
| V10.4.10 | Confidential clients authenticated on back-channel requests | L2 | Met | client_secret_basic or client_secret_post, constant-time compare, hashed secrets [`public-api.int.test.ts`](../apps/api/test/public-api.int.test.ts) ("issues short-lived bearer tokens limited to the requested scopes; rotation keeps the old secret for the grace period") |
| V10.4.11 | Only required scopes assigned to clients | L2 | Met | Requested scopes must be a subset of the client's; creators cannot exceed their own permissions [`public-api.int.test.ts`](../apps/api/test/public-api.int.test.ts) ("can never carry permissions the creator does not hold") |
| V10.5.1 | ID token replay mitigated (nonce) | L2 | Met | Nonce per transaction, checked by openid-client [`sso.ts`](../apps/api/src/modules/auth/sso.ts) |
| V10.5.2 | User identified by non-reassignable claims (sub) | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | Users are matched by verified email within the tenant, not by `sub` |
| V10.5.3 | Issuer metadata must match the configured issuer | L2 | Met | openid-client discovery refuses metadata whose `issuer` differs from the configured URL [`sso.ts`](../apps/api/src/modules/auth/sso.ts) |
| V10.5.4 | ID token audience equals client_id | L2 | Met | openid-client [`sso.ts`](../apps/api/src/modules/auth/sso.ts) |
| V10.5.5 | Back-channel logout tokens validated | L2 | Not applicable (back-channel logout is not supported) | [SECURITY.md → Sessions](SECURITY.md#sessions) |
| V10.6.1 | OP allows only safe response modes | L2 | Not applicable (Thapsus-HR is not an OpenID Provider (out of scope: CLAUDE.md)) | — |
| V10.6.2 | OP mitigates forced logout | L2 | Not applicable (not an OpenID Provider) | — |
| V10.7.1 | AS obtains user consent per authorization request | L2 | Not applicable (no user-delegated authorization: clients act with an admin-chosen role and scopes) | — |
| V10.7.2 | Consent prompts are clear | L2 | Not applicable (no consent prompts) | — |
| V10.7.3 | Users can review and revoke consents | L2 | Not applicable (no user consents; admins list and revoke clients) | [`public-api.int.test.ts`](../apps/api/test/public-api.int.test.ts) |

## V11 Cryptography

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V11.1.1 | Documented key management policy (NIST SP 800-57) | L2 | Fixed in this review | [SECURITY.md → Cryptographic inventory and key management](SECURITY.md#cryptographic-inventory-and-key-management) |
| V11.1.2 | Maintained cryptographic inventory | L2 | Fixed in this review | [SECURITY.md → Cryptographic inventory and key management](SECURITY.md#cryptographic-inventory-and-key-management) |
| V11.2.1 | Industry-validated implementations | L2 | Met | Node.js crypto (OpenSSL), AWS KMS, @node-rs/argon2, @simplewebauthn/server, openid-client [`kms.ts`](../apps/api/src/lib/kms.ts) |
| V11.2.2 | Crypto agility (algorithms and keys replaceable) | L2 | Met | Envelopes carry a version and key id; Argon2id hashes carry their parameters (PHC); KMS keys rotate [`kms.ts`](../apps/api/src/lib/kms.ts); [`platform.int.test.ts`](../apps/api/test/platform.int.test.ts) ("stores ciphertext only, refuses roles without permission and audits every decrypt") |
| V11.2.3 | At least 128-bit security for all primitives | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | Our keys: AES-256, SHA-256, P-256, 256-bit tokens; external RSA-2048 keys (RS256 passkeys, customer IdPs) give 112 bits |
| V11.3.1 | No ECB or weak padding | L1 | Met | AES-256-GCM only [`kms.ts`](../apps/api/src/lib/kms.ts) |
| V11.3.2 | Approved ciphers and modes (AES-GCM) | L1 | Met | [`kms.ts`](../apps/api/src/lib/kms.ts); [`platform.int.test.ts`](../apps/api/test/platform.int.test.ts) ("ciphertext from one tenant cannot be decrypted in another tenant (AAD binding)") |
| V11.3.3 | Authenticated encryption | L2 | Met | AES-GCM with AAD (tenant, category, field) [`platform.int.test.ts`](../apps/api/test/platform.int.test.ts) ("ciphertext from one tenant cannot be decrypted in another tenant (AAD binding)") |
| V11.4.1 | Approved hash functions only (no MD5) | L1 | Fixed in this review | SHA-256 throughout; SAML responses signed or digested with SHA-1/MD5 are now refused; HMAC-SHA1 only inside RFC 6238 TOTP (approved for HMAC) [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("flags SHA-1 and MD5 signature or digest algorithms, accepts SHA-2") |
| V11.4.2 | Passwords stored with an approved slow KDF | L2 | Met | Argon2id, 19 MiB, t=2, p=1 (OWASP) [`tokens.ts`](../apps/api/src/modules/auth/tokens.ts) |
| V11.4.3 | Collision-resistant hashes ≥ 256 bits for integrity | L2 | Met | SHA-256 audit hash chain and checksums [`audit.int.test.ts`](../packages/db/test/audit.int.test.ts) ("seals entries into a per-tenant hash chain that verifies") |
| V11.4.4 | Key derivation from passwords with stretching | L2 | Not applicable (no keys are derived from passwords) | — |
| V11.5.1 | CSPRNG with ≥ 128 bits for non-guessable values | L2 | Met | 256-bit `randomBytes` tokens, 128-bit CSP nonces; UUIDs are identifiers only, never the secret [`csp.test.ts`](../apps/web/test/csp.test.ts) ("nonces are fresh 128-bit values") |
| V11.6.1 | Approved public-key algorithms | L2 | Met | WebAuthn signatures verified by @simplewebauthn/server; RSA keys are generated only for the dev mock IdP [`platform.int.test.ts`](../apps/api/test/platform.int.test.ts) ("registers a passkey and signs in with it (counts as MFA)") |

## V12 Secure Communication

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V12.1.1 | Only TLS 1.2 and 1.3, 1.3 preferred | L1 | Met by platform (AWS, `ApplicationListener sslPolicy RECOMMENDED_TLS (TLS13-1-2)`) | [`infra.test.ts`](../infra/test/infra.test.ts) ("3. every ALB has a WAF web ACL association; HTTPS is TLS 1.2+ and HTTP only redirects") |
| V12.1.2 | Only recommended cipher suites, strongest preferred | L2 | Met by platform (AWS, `ELBSecurityPolicy-TLS13-1-2-2021-06`) | [`shared.ts`](../infra/lib/shared.ts) |
| V12.1.3 | mTLS client certificates validated | L2 | Not applicable (no mutual TLS) | — |
| V12.2.1 | TLS for all external HTTP services, no fallback | L1 | Met | HTTPS listener only; HTTP redirects pages and refuses API paths; HSTS [`infra.test.ts`](../infra/test/infra.test.ts) ("3. every ALB has a WAF web ACL association; HTTPS is TLS 1.2+ and HTTP only redirects") |
| V12.2.2 | Publicly trusted certificates | L1 | Met by platform (AWS, `ACM certificates (CertificateArn parameter)`) | Staging may use a self-signed certificate until the domain exists ([HUMAN_TODO 2.1, 2.2](HUMAN_TODO.md)) |
| V12.3.1 | Encrypted protocols for all connections in and out | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | Database (TLS, verified), Valkey (TLS), AWS APIs (HTTPS), webhooks (HTTPS only), SFTP (SSH) [`tls.test.ts`](../packages/db/test/tls.test.ts); ALB → containers and web → API inside the VPC are plain HTTP |
| V12.3.2 | TLS clients validate server certificates | L2 | Fixed in this review | Database pools no longer disable verification; `verify-full`; RDS CA bundle pinned in the images [`tls.test.ts`](../packages/db/test/tls.test.ts) ("pools for AWS endpoints always verify the server certificate; local Docker Postgres has no TLS"); [ADR-0135](DECISIONS.md) |
| V12.3.3 | TLS between internal HTTP services | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | ALB → target groups and Service Connect use HTTP inside private subnets |
| V12.3.4 | Internal TLS uses trusted certificates | L2 | Met | Database and Valkey certificates chain to the Amazon RDS CA / public CAs and are verified [`tls.test.ts`](../packages/db/test/tls.test.ts) ("the API and worker images trust the Amazon RDS CA bundle (pinned by checksum) for the Aurora endpoints") |

## V13 Configuration

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V13.1.1 | All communication needs documented (incl. user-supplied destinations) | L2 | Met | `docs/ARCHITECTURE.md`, `docs/SUBPROCESSORS.md`, `docs/integrations.md` (webhooks, SIEM, SFTP, customer S3) |
| V13.2.1 | Backend authentication without static credentials | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | Task roles (IAM) for AWS APIs; database and Valkey use generated passwords from Secrets Manager |
| V13.2.2 | Least-privilege backend accounts | L2 | Met | [`rls.isolation.test.ts`](../packages/db/test/rls.isolation.test.ts) ("the application role has no BYPASSRLS, is not superuser and owns no tables"); [`infra.test.ts`](../infra/test/infra.test.ts) ("7. IAM: no wildcard actions and no Resource "*" outside the documented allow-list") |
| V13.2.3 | No default credentials | L2 | Met | Secrets generated per environment; staging and production refuse to start with dev defaults [`config.test.ts`](../packages/core/test/config.test.ts) |
| V13.2.4 | Allow-list of external resources | L2 | Met | Outbound calls only to public HTTPS hosts checked at connect time; integration host allow-list (ADR-0063) [`outbound.test.ts`](../apps/api/test/outbound.test.ts) ("refuses non-https, credentials in the URL, literal private IPs and internal names") |
| V13.2.5 | Server configured with an allow-list of request destinations | L2 | Met | Same controls as V13.2.4; AWS clients only through the residency-guarded factory (home region) [`core.test.ts`](../packages/core/test/core.test.ts) ("checks ARNs and endpoint URLs") |
| V13.3.1 | Secrets in a secrets manager, not in code or artifacts | L2 | Met | AWS Secrets Manager referenced by ARN; secret scan in verify [`secret-scan.mjs`](../scripts/secret-scan.mjs); [`infra.test.ts`](../infra/test/infra.test.ts) |
| V13.3.2 | Least-privilege access to secrets | L2 | Met | Each task reads only its own secrets (`ecs.Secret.fromSecretsManager`) [`infra.test.ts`](../infra/test/infra.test.ts) ("7. IAM: no wildcard actions and no Resource "*" outside the documented allow-list") |
| V13.4.1 | No source-control metadata deployed | L1 | Met | Images copy only the `pnpm deploy` output into the runtime stage (`apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/web/Dockerfile`) |
| V13.4.2 | Debug modes off in production | L2 | Met | `NODE_ENV=production`, Next.js production build, mock IdP refused in prod, dev routes only in dev/test [`infra.test.ts`](../infra/test/infra.test.ts) ("8. the mock IdP is enabled in dev/staging only (never in prod or the load-test environment)") |
| V13.4.3 | No directory listings | L2 | Met | Neither Fastify nor Next.js lists directories; S3 is private |
| V13.4.4 | HTTP TRACE not supported | L2 | Met | TRACE has no route (404, nothing echoed) [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("TRACE (and other unrouted methods) are not supported") |
| V13.4.5 | Internal docs and monitoring endpoints not exposed unless intended | L2 | Met | `/openapi.json` is the intentionally public API reference; `/health` returns status only [`app.ts`](../apps/api/src/app.ts) |

## V14 Data Protection

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V14.1.1 | Sensitive data identified and classified | L2 | Fixed in this review | [SECURITY.md → Data classification and protection](SECURITY.md#data-classification-and-protection) |
| V14.1.2 | Protection requirements per level documented | L2 | Fixed in this review | [SECURITY.md → Data classification and protection](SECURITY.md#data-classification-and-protection) |
| V14.2.1 | No sensitive data in URLs | L1 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | Session tokens and API keys never in URLs; calendar feed tokens and emailed sign-in links are documented exceptions |
| V14.2.2 | No sensitive data cached in server components | L2 | Met | `Cache-Control: private, no-store` everywhere; no CDN in front of cells [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("sets Cache-Control: private, no-store on public and authenticated responses"); [`infra.test.ts`](../infra/test/infra.test.ts) ("4. no template contains a CloudFront distribution") |
| V14.2.3 | No sensitive data to untrusted parties (trackers) | L2 | Met | No analytics or third-party scripts; CSP `connect-src 'self'`; sub-processors listed in `docs/SUBPROCESSORS.md` [`csp.test.ts`](../apps/web/test/csp.test.ts) |
| V14.2.4 | Controls implemented per protection level | L2 | Met | Vault encryption and audits, retention, scrubbed logs, residency [`platform.int.test.ts`](../apps/api/test/platform.int.test.ts) ("stores ciphertext only, refuses roles without permission and audits every decrypt"); [`core.test.ts`](../packages/core/test/core.test.ts) ("logger output never contains personal data") |
| V14.3.1 | Authenticated data cleared from client storage at session end | L1 | Fixed in this review | `Clear-Site-Data: "cache"` on logout and a full reload; queued offline punches are the documented exception ([SECURITY.md → Browser storage](SECURITY.md#browser-storage)) [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("logout clears the cookie with the same attributes and sends Clear-Site-Data"); [`security-asvs.spec.ts`](../apps/web/e2e/security-asvs.spec.ts) ("people see where they are signed in, re-authenticate when the sign-in is old, and sign other sessions out") |
| V14.3.2 | Anti-caching headers (no-store) | L2 | Met | [`auth.int.test.ts`](../apps/api/test/auth.int.test.ts) ("sets Cache-Control: private, no-store on public and authenticated responses"); [`foundation.spec.ts`](../apps/web/e2e/foundation.spec.ts) ("owner signs up in the UK region, must enrol MFA, then reaches the app") |
| V14.3.3 | No sensitive data in browser storage (except session tokens) | L2 | Gap — recorded in [SECURITY.md → Accepted risks](SECURITY.md#accepted-risks-and-follow-ups) | [SECURITY.md → Browser storage](SECURITY.md#browser-storage): offline clock punches stay in `localStorage` until sent |

## V15 Secure Coding and Architecture

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V15.1.1 | Remediation timeframes for vulnerable components | L1 | Fixed in this review | [SECURITY.md → Dependency remediation](SECURITY.md#dependency-remediation) |
| V15.1.2 | SBOM maintained; components from trusted repositories | L2 | Fixed in this review | CycloneDX SBOM in verify and CI [`sbom.test.ts`](../scripts/test/sbom.test.ts) ("the lockfile yields a clean CycloneDX SBOM of the production dependencies"); [ADR-0135](DECISIONS.md) |
| V15.1.3 | Resource-demanding functionality documented | L2 | Met | `docs/PERFORMANCE.md` (imports, reports, exports, rota), ADR-0019, ADR-0006 (background jobs) |
| V15.2.1 | Components within remediation timeframes | L1 | Met | `pnpm audit --audit-level high --prod` in verify and CI (`scripts/verify.mjs`, `.github/workflows/ci.yml`) |
| V15.2.2 | Defences against resource exhaustion | L2 | Met | Background jobs, row caps, statement timeouts, keyset pagination, rate limits, bounded archives [`public-api.int.test.ts`](../apps/api/test/public-api.int.test.ts) ("returns 429 with Retry-After and RateLimit headers once the tenant limit is used up; other tenants are unaffected"); [`asvs-units.test.ts`](../apps/api/test/asvs-units.test.ts) ("shares one inflation budget across entries and archives") |
| V15.2.3 | No test or development functionality in production | L2 | Fixed in this review | Mock IdP and dev download routes refused outside dev/test; the design gallery is no longer served in production [`infra.test.ts`](../infra/test/infra.test.ts) ("8. the mock IdP is enabled in dev/staging only (never in prod or the load-test environment)"); `apps/web/app/design/gallery/page.tsx` |
| V15.3.1 | Return only required fields | L1 | Met | Response schemas serialise declared fields only; explicit mappers; secrets never returned [`openapi.contract.test.ts`](../apps/api/test/openapi.contract.test.ts) |
| V15.3.2 | External calls do not follow redirects | L2 | Met | [`outbound.test.ts`](../apps/api/test/outbound.test.ts) ("does not follow redirects and never returns the response body"); automation calls use `redirect: 'error'` |
| V15.3.3 | Mass assignment countermeasures | L2 | Fixed in this review | [`mass-assignment.contract.test.ts`](../apps/api/test/mass-assignment.contract.test.ts) ("every route body removes or refuses a field it does not declare"); [`mass-assignment.contract.test.ts`](../apps/api/test/mass-assignment.contract.test.ts) ("a handler never sees undeclared fields, at any depth; declared maps keep their keys"); [ADR-0134](DECISIONS.md) |
| V15.3.4 | Correct client IP through proxies | L2 | Met | [`proxy-trust.test.ts`](../apps/api/test/proxy-trust.test.ts) ("uses the address the trusted proxy appended, never one the client supplied") |
| V15.3.5 | Strict types and equality | L2 | Met | TypeScript strict, ESLint `eqeqeq`, TypeBox validation without coercion of bodies (`eslint.config.mjs`, `apps/api/src/http/validation.ts`) |
| V15.3.6 | Prototype pollution prevented | L2 | Met | Fastify refuses `__proto__` / `constructor` keys in JSON; body cleaning removes undeclared keys [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("refuses prototype-pollution keys in JSON bodies") |
| V15.3.7 | HTTP parameter pollution defences | L2 | Met | Query, body, params and headers are separate typed sources; a repeated scalar parameter fails validation [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("a repeated query parameter does not change its type (HTTP parameter pollution)") |

## V16 Security Logging and Error Handling

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V16.1.1 | Logging inventory per layer | L2 | Fixed in this review | [SECURITY.md → Security logging](SECURITY.md#security-logging) |
| V16.2.1 | Log entries carry when, where, who, what | L2 | Met | [`foundation.int.test.ts`](../apps/api/test/foundation.int.test.ts) ("records actor, IP, user agent and request id on audited mutations") |
| V16.2.2 | Synchronised time, UTC timestamps | L2 | Met by platform (AWS, `Amazon Time Sync for Fargate and Aurora`) | Audit times are `timestamptz` (UTC); pino logs epoch milliseconds [`foundation.int.test.ts`](../apps/api/test/foundation.int.test.ts) ("instants are timestamptz everywhere (no timestamp without time zone)") |
| V16.2.3 | Logs only go to documented destinations | L2 | Met | [SECURITY.md → Security logging](SECURITY.md#security-logging); log groups are created only by CDK [`infra.test.ts`](../infra/test/infra.test.ts) ("9. every log group is KMS-encrypted with a retention period") |
| V16.2.4 | Common, machine-readable log format | L2 | Met | JSON lines (pino); audit export in CSV and JSON [`platform.int.test.ts`](../apps/api/test/platform.int.test.ts) ("every successful mutating call writes an audit entry, and exports are filtered by date in CSV and JSON") |
| V16.2.5 | Sensitive data logged according to protection level | L2 | Met | [`core.test.ts`](../packages/core/test/core.test.ts) ("logger output never contains personal data"); [`audit.int.test.ts`](../packages/db/test/audit.int.test.ts) ("redacts sensitive fields in diffs") |
| V16.3.1 | All authentication operations logged | L2 | Fixed in this review | Sign-ins and failures on every path, MFA, re-authentication; SSO callback failures and staff sign-in failures are now audited [`sso.int.test.ts`](../apps/api/test/sso.int.test.ts) ("only the browser that started the sign-in can finish it (no login CSRF), and failures are audited"); [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("people list their sessions and, after re-authenticating, end one or all of the others") |
| V16.3.2 | Failed authorisation attempts logged | L2 | Fixed in this review | `authz.denied` security events [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("refused requests are logged as structured security events with pseudonymous ids only") |
| V16.3.3 | Bypass attempts (validation, business logic, anti-automation) logged | L2 | Fixed in this review | `input.rejected`, `antiautomation.limited`, origin refusals [`asvs.int.test.ts`](../apps/api/test/asvs.int.test.ts) ("refused requests are logged as structured security events with pseudonymous ids only") |
| V16.3.4 | Unexpected errors and security control failures logged | L2 | Met | The error handler logs every unhandled error and residency violation; SAML/OIDC validation failures are logged [`errors.ts`](../apps/api/src/http/errors.ts) |
| V16.4.1 | Log encoding prevents injection | L2 | Met | Structured JSON logging (pino) escapes every value [`logger.ts`](../packages/core/src/logger.ts) |
| V16.4.2 | Logs protected from unauthorised access and modification | L2 | Met | [`audit.int.test.ts`](../packages/db/test/audit.int.test.ts) ("the application role cannot UPDATE or DELETE audit rows (no privilege)"); [`audit.int.test.ts`](../packages/db/test/audit.int.test.ts) ("verification detects tampering"); CloudWatch logs KMS-encrypted [`infra.test.ts`](../infra/test/infra.test.ts) ("9. every log group is KMS-encrypted with a retention period") |
| V16.4.3 | Logs sent to a logically separate system | L2 | Met by platform (AWS, `CloudWatch Logs (awslogs driver) and customer SIEM streams`) | [`audit-streams.int.test.ts`](../apps/worker/test/audit-streams.int.test.ts) |
| V16.5.1 | Generic error messages to consumers | L2 | Met | RFC 9457 problems with catalogue titles; no stack traces, queries or tokens returned [`errors.ts`](../apps/api/src/http/errors.ts) |
| V16.5.2 | Secure operation when external resources fail | L2 | Met | Timeouts, retries with backoff and dead-letter queues, server-session fallback, status reporting [`outbound.test.ts`](../apps/api/test/outbound.test.ts) ("retries with exponential backoff, capped"); [`status.int.test.ts`](../apps/api/test/status.int.test.ts) ("reports email delivery problems from the recorded outcomes (timestamps and counts only)") |
| V16.5.3 | Fail securely (no fail-open) | L2 | Met | Errors roll back the transaction; unknown errors become 500; authentication fails closed (unresolvable session = 401) [`sessions.ts`](../apps/api/src/modules/auth/sessions.ts) |

## V17 WebRTC

Thapsus-HR has no WebRTC (no audio, video or peer-to-peer features), so the chapter does not apply.

| ID | Requirement (short) | Level | Status | Evidence |
| --- | --- | --- | --- | --- |
| V17.1.1 | TURN server refuses reserved IP ranges | L2 | Not applicable (no WebRTC) | — |
| V17.2.1 | DTLS certificate key managed per policy | L2 | Not applicable (no WebRTC) | — |
| V17.2.2 | Approved DTLS cipher suites and SRTP profile | L2 | Not applicable (no WebRTC) | — |
| V17.2.3 | SRTP authentication checked | L2 | Not applicable (no WebRTC) | — |
| V17.2.4 | Media server survives malformed SRTP | L2 | Not applicable (no WebRTC) | — |
| V17.3.1 | Signalling rate-limited under flood | L2 | Not applicable (no WebRTC) | — |
| V17.3.2 | Signalling survives malformed messages | L2 | Not applicable (no WebRTC) | — |
