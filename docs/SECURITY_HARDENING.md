# Thapsus-HR security hardening plan — zero trust, built for AI-assisted attackers

Status: APPROVED for implementation by the product owner on 2026-10-23 (P0 code items first; P1 and P2 need cost approval or owner steps). Progress is tracked in docs/PROGRESS.md, Phase 15.

## 1. Goal and threat picture

Pass an independent CREST-standard pentest (web, API, cloud configuration, social engineering) with no critical or high findings, and detect and contain an attack in minutes, not days.

AI changes the attacker's economics: recon, fuzzing, credential stuffing through residential proxies, phishing and deepfake voice are now cheap and fast, and exploit windows shrink to hours. Defences must therefore be: phishing-resistant identity, per-identity (not per-IP) throttling, deny-by-default authorisation, anomaly detection on behaviour, honeytokens, short patch windows, and automated containment.

Zero-trust rules applied throughout: verify every request explicitly (identity + device + context); least privilege with just-in-time elevation; assume breach (segment, encrypt, monitor, limit blast radius); deny by default; no implicit trust from network location, including inside the VPC.

Success criteria: CIS AWS Foundations ≥ 95%, Security Hub AFSBP ≥ 95%; ASVS L2 everywhere and L3 for authentication, sessions and the back office; zero accepted risks rated high; high-severity detection < 5 min; containment < 30 min; pentest retest clean.

## 2. Hardening, top to bottom

### 2.1 Customer identity and sessions

1. Passkeys as the default second factor; TOTP kept as fallback; SMS never. _Status: not part of P0. Passkeys and authenticator apps were already offered and SMS never is; offering passkeys first at enrolment is still to do._
2. Tenant setting "require two-step verification for everyone", ON by default for new workspaces (closes accepted risk V6.3.3). _Status: **done** (Phase 15, ADR-0170). On for every workspace created from migration 0024 on (sign-up, provisioning CLI, staging seed, sandboxes); existing workspaces keep their behaviour; turning it off needs a recent re-authentication._
3. SSO identity binding on (connection, issuer, subject) after first sign-in; honour `amr`/`acr`; "Trust IdP MFA" defaults OFF (closes V6.8.1, V6.8.4). _Status: **done** (Phase 15, ADR-0172). Binding per connection; a changed subject is refused and raises `auth.sso_subject_mismatch`; admins can unlink a person's SSO identity._
4. Risk-based sign-in: new device, new country/ASN, impossible travel, Tor/hosting ASN → step-up or block; signals stored pseudonymously, in-region. _Status: not part of P0 (needs the network signals below)._
5. Session hardening: admin sessions re-authenticate on ASN change; idle 15 min / absolute 8 h for admin roles; device-bound session cookies where browsers support them. _Status: **partly done** (Phase 15, ADR-0170). Admin sessions: 15 min idle, 8 h absolute; re-authentication on a network (ASN) change is built and tested, but no cell has the ASN signal yet (it needs a trusted edge header, `CLIENT_ASN_HEADER`), so it is inactive. Device-bound session cookies: not started (no stable browser support)._
6. Credential stuffing defence: per-account and per-tenant throttles in addition to per-IP; AWS WAF Challenge/CAPTCHA on sign-in after anomalies; WAF Bot Control and Account Takeover Prevention rule groups (recurring cost). _Status: **partly done** (Phase 15, ADR-0172). Per-account, per-IP and per-workspace throttles on sign-in, emailed links, password resets and two-step verification, each emitting `auth.*` security events. WAF Challenge, Bot Control and ATP: P1 (recurring cost, owner approval)._
7. Uniform responses and timing on every authentication path (no account enumeration). _Status: **partly done** for the emailed-link and password-reset requests (identical body and a 300 ms floor, email sent after the response); password sign-in already took the same time for unknown accounts (a dummy Argon2id check). Gap: a temporarily locked account still answers "locked", which tells an attacker the account exists._

### 2.2 Thapsus staff (back office) — strictest tier

1. Hardware security keys (FIDO2) only; remove staff passwords and TOTP (closes V6.4.1). _Status: **done** (Phase 15, ADR-0173). Passkeys or security keys with user verification; the password and TOTP routes are gone; bootstrap by a one-time enrolment link from the operator CLI (`docs/runbooks/staff-access.md`) or, on Google Cloud staging, the staff-invite job (ADR-0174). Key attestation (hardware-only) is not enforced yet._
2. Back office on its own host name, reachable only through AWS Verified Access (identity + device posture per request) — no public login page (closes V3.5.4). _Status: P1 (owner steps and cost)._
3. Just-in-time elevation: staff hold no standing access; super-admin actions, rule publishing and support-grant use need a time-boxed elevation with a reason and a second person's approval. _Status: **done** (Phase 15, ADR-0173). Scopes `super_admin`, `rules_publish`, `support_grant`; reason, 5 min to 4 h, second-person approval (the database refuses self-approval), revocable, audited._
4. Break-glass accounts: two sealed accounts per cell, keys in a safe, any use pages the whole security list. _Status: not started._
5. Sessions: 15 min idle, 4 h absolute; re-auth before every destructive action. _Status: **done** (Phase 15, ADR-0173). Destructive actions need a key proof from the last 5 minutes._
6. Quarterly access reviews; separation of duties (rules editors cannot approve their own rule versions; support cannot grant itself access). _Status: partly in place: support cannot grant itself access (customer-initiated grants) and nobody approves their own elevation; access reviews are a process step, not started._

### 2.3 Application

1. Close remaining ASVS gaps: route automation webhooks and the `http` integration through `postOutbound` (DNS-pinned, private ranges blocked — closes SSRF V1.3.6); bind SAML responses to the starting browser; shorten and scope URL tokens. _Status: **done** (Phase 15, ADR-0172): webhooks and the `http` integration use `postOutbound` (V1.3.6 fixed); SAML responses are bound to the browser that started the sign-in; reset links last 30 minutes (24 h when an admin sends one), invitations 3 days, and every emailed link is scoped to one purpose._
2. ASVS L3 review of authentication, sessions, authorisation and the back office.
3. Browser hardening: Trusted Types, Subresource Integrity, COOP/COEP/CORP, strict Permissions-Policy, HSTS preload.
4. API: short-lived OAuth tokens by default, per-key IP allowlists, mandatory key expiry, scoped keys; per-key and per-tenant adaptive rate limits; GitHub secret-scanning partner pattern for `thr_sk_` keys.
5. Authorisation tests: generated IDOR/BOLA suite that calls every route as every built-in role against another tenant's and another team's IDs (extends the isolation suite to the HTTP layer). _Status: **done** (Phase 15.17): `apps/api/test/bola.isolation.test.ts` walks every id-addressed operation in the OpenAPI document as every built-in role against another workspace's ids, and as the scoped roles against people outside their scope; it is part of the isolation step of `pnpm verify` and found seven real bugs, which are fixed._
6. Uploads: malware scanning (GuardDuty Malware Protection for S3), image re-encoding, PDF sanitising; quarantine bucket until clean (closes V5.4.3).
7. Business-logic abuse tests: self-approval, approval-chain bypass, privilege escalation through role editing, payroll export tampering.

### 2.4 AI — defending Ask HR and defending against AI attackers

1. Ask HR: keep it tool-less; Bedrock Guardrails (in-region) on input and output; PII-leak output filter; per-user and per-tenant token and cost caps; prompt-injection canaries in the retrieval set; red-team suite (jailbreaks, injection via uploaded documents) in CI; full invocation audit without personal data.
2. Honeytokens: fake employee records, fake API keys in docs and repos, honey endpoints and decoy S3 objects; any touch is a critical alert. _Status: **done except fake employees** (Phase 15.16, ADR-0179): decoy API key in the docs, honey endpoints and decoy object keys raise detections; fake employees are deliberately not put in customer workspaces._
3. Behavioural detection of automated attackers: enumeration patterns, high `authz.denied` / `input.rejected` rates, sequential ID probing, abnormal pagination; responses are tarpit, challenge and block. _Status: **partly done** (Phase 15.13): rules for enumeration, `authz.denied` / `input.rejected` bursts and probing raise incidents and can block the address in the app; tarpit and challenge at the edge (WAF or Cloud Armor) are P1._
4. Social engineering: support never acts on voice, video or email requests to change access; only customer-initiated, time-boxed grants (already the model); deepfake-aware staff training; out-of-band verification for any billing or owner change.

### 2.5 Data layer

1. RDS IAM authentication or Secrets Manager rotation every 30 days for every database role (closes V13.2.1).
2. `pgaudit` for owner and migrator sessions; alert on any owner-role session outside a deploy window.
3. KMS key policies that require encryption context; alerts on bulk vault decrypts and on key-policy changes.
4. Ransomware resilience: AWS Backup Vault Lock in compliance mode (WORM); copies to a separate backup account within the same jurisdiction; quarterly restore drills.

### 2.6 Network and runtime

1. TLS end to end: ALB to containers with a private CA, and Service Connect TLS between services (closes V12.3.3).
2. Egress control: AWS Network Firewall domain allowlist (SES, Bedrock, customer-approved integrations only); blocks exfiltration and SSRF callbacks (recurring cost).
3. VPC interface endpoints for AWS APIs, so no AWS traffic crosses the internet.
4. Containers: distroless, non-root, read-only root filesystem, all capabilities dropped; images signed (AWS Signer / Sigstore) and verified at deploy; ECR enhanced scanning (Inspector); GuardDuty ECS Runtime Monitoring.
5. Security groups audited by tests: no `0.0.0.0/0` except the ALB listener.

### 2.7 AWS accounts and cloud posture (mostly owner steps)

1. Account structure: management, security/audit, log-archive, prod, staging and loadtest accounts.
2. SCPs (beyond the region allowlist): deny disabling CloudTrail, GuardDuty, Config or Security Hub; deny root use; deny IAM users and access keys; deny public S3; deny leaving the organisation.
3. CloudTrail organisation trail with log-file validation into a log-archive bucket with Object Lock.
4. GuardDuty (all protection plans), Security Hub (CIS + AFSBP), Config conformance packs, IAM Access Analyzer (external and unused access), Macie on buckets that hold documents — all in the five allowed regions only.
5. Root: hardware MFA, no keys, alarms on any use; scoped CDK bootstrap execution policy.

### 2.8 Supply chain and SDLC

1. Dependency cooldown: new versions only after 7 days (AI-generated malicious packages are usually caught within days); install scripts allowed only for an allowlist; registry provenance checks; lockfile lint. _Status: **partly done** (Phase 15.18): 7-day `minimumReleaseAge` and an install-script allowlist (`strictDepBuilds`), enforced by `pnpm verify`; registry provenance checks and lockfile lint are still to do._
2. Patch windows: critical 48 h, high 7 days; Renovate PRs through `pnpm verify`.
3. SAST (CodeQL), IaC scanning (cdk-nag in the synth step), DAST (OWASP ZAP authenticated scan of staging every night), container scanning.
4. GitHub: signed commits, required reviews, `main` ruleset, actions pinned by SHA, least-privilege `GITHUB_TOKEN`, runner egress allowlist.

### 2.9 Email, DNS and brand

DMARC `p=reject`, SPF, DKIM, MTA-STS, TLS-RPT; DNSSEC; CAA records; lookalike-domain monitoring; `security.txt` and a vulnerability disclosure policy.

## 3. Thapsus admin security operations

### 3.1 Unauthorised activity monitoring

_Status: **done in the app** (Phase 15.13–15.14, ADR-0177, ADR-0178): signals, 21 active rules with fixtures (cloud rules planned), incidents with dedupe and containment; cloud sources (GuardDuty, CloudTrail, Security Hub) are P1._

**Pipeline (per region, residency-safe):**

- Sources: app security events, customer audit log, staff trail, WAF/ALB logs, CloudTrail, GuardDuty/Security Hub findings, flow logs, pgaudit, KMS and Bedrock logs.
- Flow: EventBridge → detection worker in the cell → `security.detections` in the home region, with pseudonymous ids and no personal data.
- The global layer receives only counts and severities.

**Detection rules:** a versioned, effective-dated catalogue in the repo (like jurisdiction packs). Each rule carries a severity, a MITRE ATT&CK mapping, a test fixture and a tuning history.

| Area               | Example rules                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Credential attacks | failures across many accounts from one IP/ASN; spikes in a tenant's failure ratio; success after many failures; lockout storms             |
| Account takeover   | new device + new country + MFA reset; impossible travel; one session used from two ASNs; passkey removed then re-added                     |
| Privilege changes  | admin-grade role granted; owner added; MFA reset by an admin; SSO or SCIM changes; broad API key created; support grant created            |
| Exfiltration       | export or report volume far above the person's baseline; bulk vault decrypts; directory scraping by pagination; downloads at unusual hours |
| Probing            | bursts of `authz.denied` (IDOR attempts), sequential 404s, `input.rejected` spikes (fuzzers)                                               |
| Staff              | sign-in from a new device; elevation outside working hours; one staff member viewing many tenants; break-glass use; rule publishing        |
| Cloud              | GuardDuty high/critical; root sign-in; IAM or key-policy changes; trail or detector stopped; security group opened; SCP denials            |
| Deception          | any honeytoken touched                                                                                                                     |
| AI                 | jailbreak-classifier hits; token-use spikes; injection canary echoed                                                                       |

**Correlation and tuning:**

- Detections roll up into incidents.
- Each incident has dedupe windows, allowlists and an owner.

**Automated containment** (audited, reversible, no customer-data deletion ever):

- block the IP or ASN in the WAF IP set;
- force step-up or end a person's sessions;
- suspend an API key;
- freeze a staff account; unfreezing needs two people.

### 3.2 Security dashboard (back office "Security" module)

_Status: **done (v1)** (Phase 15.14): overview, incidents, rules and decoys for `security_analyst` and super admin; customers get a Security centre in Settings. Live region tabs work for the cell the console runs in; posture scores need the P1 cloud services._

**Access:** new staff role `security_analyst`, plus super admin.

**Overview screen:**

- posture score (Security Hub);
- open findings by severity;
- live detections (24 h);
- open incidents with MTTA and MTTR;
- authentication health per region: success and failure rates, lockouts, MFA adoption;
- WAF blocks and bot share;
- top offending IPs and ASNs;
- staff elevation log;
- Ask HR abuse.

**Region tabs (UK, EU, US):** details are fetched live from each cell. Nothing personal leaves its region.

**Incident view:**

- timeline and related events;
- affected tenants;
- one-click actions (block, end sessions, suspend key, notify tenant admins);
- assignment, status and notes;
- post-mortem export.

**Admin screens:**

- detection rule catalogue (thresholds, enable or disable, last test result);
- honeytoken registry;
- access-review screen.

**Customer side:** a "Security centre" in Settings with their workspace's suspicious sign-ins, admin changes, MFA adoption and alert recipients.

### 3.3 Email alerts

_Status: **done** (Phase 15.15) through the cell's mailer; SES from an `alerts.` subdomain, SMS and paging are owner steps (HUMAN_TODO)._

**Delivery:** SES in each cell region from a dedicated `alerts.` subdomain with DMARC reject; SNS SMS for critical; an optional paging tool (needs a SUBPROCESSORS entry).

**Content:** severity, rule, region, tenant, counts, first and last seen, incident link. Never personal data, secrets or sign-in links. Alerts never ask for credentials.

| Severity | Timing                                                                  |
| -------- | ----------------------------------------------------------------------- |
| Critical | Email + SMS/page at once; escalate after 15 min without acknowledgement |
| High     | Email within a minute                                                   |
| Medium   | Hourly digest                                                           |
| Low      | Daily digest                                                            |

**Customer alerts:** tenant admins get emails for new admins, MFA resets, SSO changes, suspicious sign-ins and bulk exports in their workspace (configurable).

**Reliability:**

- a daily test alert;
- a dead-man's switch alarm if no events are processed for 10 minutes;
- an alarm on SES bounces or complaints.

## 4. Pentest readiness

**Scope:** app, public API, SCIM, SSO, back office, AWS configuration (read-only role), plus a social-engineering test of the support desk.

**Setup:** fictional data and test tenants in all three staging regions; rules of engagement signed by the owner.

**Before the test, internally:**

- ZAP full authenticated scan;
- manual OWASP WSTG checklist;
- cdk-nag and Prowler (CIS) clean;
- IDOR suite green.

**After:** fix SLAs (critical 48 h, high 7 days), retest, results in `docs/ASVS.md` and SECURITY.md. Repeat yearly and after major changes; open a bug bounty after the first clean retest.

## 5. Phased roadmap

**P0 (first, mostly code):**

- staff hardware keys + just-in-time elevation; _(done, Phase 15)_
- SSRF fix; _(done, Phase 15)_
- SSO binding; _(done, Phase 15)_
- MFA-for-everyone default; _(done, Phase 15)_
- per-account throttles; _(done, Phase 15; the `auth.*` security events feed the detection pipeline)_
- detection pipeline + first 20 rules;
- email alerts;
- security dashboard v1;
- honeytokens;
- IDOR suite;
- supply-chain cooldown.

**P1 (needs cost approval or owner steps):**

- GuardDuty, Security Hub, Config, CloudTrail org trail, Inspector, Macie;
- Backup Vault Lock;
- WAF Bot Control and ATP;
- Verified Access for the back office;
- account split and SCPs.

**P2:**

- end-to-end TLS and service mTLS;
- Network Firewall egress allowlist;
- signed images + runtime monitoring;
- DB IAM auth;
- ASVS L3 review;
- external pentest, retest, bug bounty.

Every recurring AWS cost goes into COSTS.md for approval before it is turned on; every account, key or vendor step goes into HUMAN_TODO.md.

## 6. Option: hosting on Google Cloud (added 2026-10-23; plan only, not implemented)

### 6.1 Region mapping (residency)

| Jurisdiction | AWS today              | Google Cloud home             | Backup copy                                      |
| ------------ | ---------------------- | ----------------------------- | ------------------------------------------------ |
| UK           | eu-west-2 London       | europe-west2 London (3 zones) | none (London only)                               |
| EU           | eu-central-1 Frankfurt | europe-west3 Frankfurt        | europe-west1 Belgium or europe-west4 Netherlands |
| US           | us-east-2 Ohio         | us-east5 Columbus, Ohio       | a US west region (us-west1 Oregon)               |

- **Enforcement:** Organization Policy `gcp.resourceLocations` on a folder per jurisdiction. This is the equivalent of today's SCP region allowlist.
- **EU:** Assured Workloads EU Data Boundary on the EU folder.

### 6.2 Service mapping

| Need                      | AWS today                                  | Google Cloud                                                                                                                                                   |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Containers                | ECS Fargate                                | Cloud Run (or GKE Autopilot)                                                                                                                                   |
| Load balancer + WAF       | ALB + AWS WAF                              | Regional external Application Load Balancer + Cloud Armor (OWASP rules, adaptive protection, reCAPTCHA Enterprise bot defence)                                 |
| PostgreSQL                | Aurora + RDS Proxy                         | AlloyDB for PostgreSQL or Cloud SQL Enterprise Plus (RLS unchanged; IAM DB auth)                                                                               |
| Cache                     | ElastiCache Valkey                         | Memorystore for Valkey                                                                                                                                         |
| Files                     | S3                                         | Cloud Storage with CMEK and bucket lock                                                                                                                        |
| Queues, schedules         | SQS, EventBridge Scheduler                 | Pub/Sub, Cloud Tasks, Cloud Scheduler                                                                                                                          |
| Keys, secrets             | KMS, Secrets Manager                       | Cloud KMS / Cloud HSM (optionally External Key Manager), Secret Manager                                                                                        |
| Email, SMS                | SES, SNS                                   | No first-party transactional email or SMS: choose an in-region provider (new sub-processor), or keep SES for email only                                        |
| AI (Ask HR)               | Bedrock in-region                          | Vertex AI Gemini on regional endpoints. In-region ML processing is listed for London and Frankfurt; the US is listed only as the US multi-region, not us-east5 |
| Logs, metrics, traces     | CloudWatch, X-Ray                          | Cloud Logging (regional log buckets with CMEK), Monitoring, Trace                                                                                              |
| Audit trail               | CloudTrail                                 | Cloud Audit Logs (Admin Activity plus Data Access) into a locked bucket in a security project                                                                  |
| Threat detection, posture | GuardDuty, Security Hub, Config, Inspector | Security Command Center: Event and Container Threat Detection, Security Health Analytics, posture; Artifact Analysis                                           |
| Sensitive-data discovery  | Macie                                      | Sensitive Data Protection                                                                                                                                      |
| Signed images             | AWS Signer                                 | Binary Authorization                                                                                                                                           |
| Zero-trust staff access   | Verified Access                            | Identity-Aware Proxy + Chrome Enterprise Premium (context-aware, device posture)                                                                               |
| Egress control            | Network Firewall                           | Cloud NGFW + Secure Web Proxy                                                                                                                                  |
| Exfiltration perimeter    | none                                       | VPC Service Controls (blocks copying data out even with stolen credentials)                                                                                    |
| Provider access           | none                                       | Access Transparency + Access Approval (Google staff need our approval); Key Access Justifications with External Key Manager                                    |
| CI identity               | GitHub OIDC roles                          | Workload Identity Federation (no keys)                                                                                                                         |
| Immutable backups         | Backup Vault Lock                          | Backup and DR backup vaults (enforced retention)                                                                                                               |
| DNS, certificates         | Route 53, ACM                              | Cloud DNS (DNSSEC), Certificate Manager                                                                                                                        |
| SIEM (optional)           | none                                       | Google Security Operations                                                                                                                                     |

### 6.3 What would change in the codebase

- **Infrastructure:** AWS CDK becomes Terraform (or Pulumi) modules per cell. The infra tests (residency, security assertions) are rewritten for the new tool.
- **Application:** cloud access moves behind ports: storage, queue, scheduler, envelope encryption, secrets, email, AI, plus a residency-guarded client factory per provider. Data model, RLS, the audit log and the UI are unchanged. Residency tests are rewritten against the Google regions.
- **Scripts:** deploy, staging smoke, load test and the HANDOVER commands are retargeted.
- **Docs:**
  - CLAUDE.md and BUILD_BRIEF name AWS regions and the SCP; they are the owner's documents to update.
  - ARCHITECTURE, COSTS, SUBPROCESSORS, the DPA/RoPA templates and HUMAN_TODO (Google Cloud organisation, folders, billing, policies) are updated.
- **Effort:** a re-platforming of several weeks of agent work. It is best decided before the staging deploy and before the pentest, so the test covers the final platform.

### 6.4 Effect on the security plan

- **Parts 1–5 carry over.** Section 2 maps one to one using the table above. The P0 items are all application-level and cloud-agnostic, so they can start either way.
- **Google Cloud strengths for zero trust:** VPC Service Controls, Access Approval, organisation location policies, IAP.
- **Gaps to solve:** email and SMS, and in-region AI processing in the US.

### 6.5 Decisions needed from the owner

1. Move to Google Cloud or stay on AWS. Avoid running both: double the residency surface.
2. The email and SMS provider and its regions (a new sub-processor).
3. Ask HR in the US: accept US multi-region processing, or keep it off in the US cell until us-east5 is listed.
4. Cloud Run or GKE Autopilot.
5. Budget for Security Command Center (Premium/Enterprise), Cloud Armor Enterprise and Chrome Enterprise Premium.

### 6.6 Suggested sequence after a go-ahead

1. Write an ADR.
2. Build the cloud adapters with tests.
3. Write the Terraform cells, with a residency and security test suite.
4. Run parity tests locally (emulators).
5. Do the staging deploy in three regions (needs owner approval: it creates cloud resources).
6. Run the security P1 items on Google Cloud.
7. Pentest the final platform.
