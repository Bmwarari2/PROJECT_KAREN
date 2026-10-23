# Compliance mapping

This maps the controls built into Thapsus-HR to the **SOC 2 Trust Services Criteria** (AICPA TSC 2017, with the 2022 points of focus) and **ISO/IEC 27001:2022 Annex A**, and points to the evidence in this repository: the code, the configuration and the automated tests that prove each control. It is an engineering self-assessment, not an audit opinion. **No independent SOC 2 examination or ISO 27001 certification has been performed.** Control titles are abbreviated (the standards' licensed text is not reproduced); check them against your copy of each standard.

Status key: **Implemented** = built and proven by a test or a check in `pnpm verify` · **Partial** = built, with a documented gap · **Gap** = not yet in place (owner and next step listed) · **Inherited** = provided by AWS under the shared responsibility model.

Evidence paths are relative to the repository root. Test names are the `describe`/`it` titles.

## 1. SOC 2 Trust Services Criteria

### Common criteria (Security)

| Criterion | Control in Thapsus-HR | Evidence | Status |
| --- | --- | --- | --- |
| CC1 Control environment | Engineering rules in CLAUDE.md; decisions recorded as ADRs | `CLAUDE.md`, `docs/DECISIONS.md` | Partial — HR policies, code of conduct, org chart and board oversight are organisational (gap G1) |
| CC2 Communication and information | Security and trust page; sub-processor list with change notices; security contact | `apps/web/app/(marketing)/trust/page.tsx`, `apps/web/e2e/privacy.spec.ts` ("public trust pages"), `docs/SUBPROCESSORS.md` | Implemented |
| CC3 Risk assessment | DPIA template; threat model planned | `docs/legal/dpia-template.md`, PROGRESS.md 12.2 | Partial — STRIDE threat model is Phase 12 (G2) |
| CC4 Monitoring activities | `pnpm verify` gate on every change; catalog-driven isolation and coverage tests | `scripts/verify.mjs`, `packages/db/test/rls.isolation.test.ts`, `apps/api/test/privacy-coverage.int.test.ts` | Implemented |
| CC5 Control activities | Deny-by-default permission engine shared by API and UI | `packages/core/src/permissions.ts`, `packages/core/test/permissions.test.ts` | Implemented |
| CC6.1 Logical access security | Forced row-level security on every tenant table; app role without BYPASSRLS owning no tables | `packages/db/test/rls.isolation.test.ts` ("every table in tenant schemas has tenant_id, forced RLS…", "the application role has no BYPASSRLS…") | Implemented |
| CC6.2 User registration and removal | SCIM provisioning and deprovisioning; sessions revoked on deprovisioning; erasure deactivates accounts | `apps/api/test/scim.int.test.ts`, `apps/api/test/privacy-dsr.int.test.ts` ("refuses while a legal hold applies…") | Implemented |
| CC6.3 Role-based access, least privilege | Built-in and custom roles with scopes and field-level access; owner-only account closure, export and DPA acceptance | `packages/core/src/roles.ts`, `apps/api/test/privacy-closure.int.test.ts` ("…is owner-only"), `apps/api/test/privacy-legal.int.test.ts` ("…owner only") | Implemented |
| CC6.1/CC6.3 Authentication | Argon2id, MFA mandatory for admins, passkeys, SSO enforcement, lockout | `apps/api/test/auth.int.test.ts`, `apps/api/test/sso.int.test.ts` | Implemented |
| CC6.4 Physical access | Data centres | AWS SOC 2 report | Inherited |
| CC6.5 Disposal of data and assets | Account closure with verified deletion across database, files (all object versions), caches and a deletion certificate; retention engine | `apps/api/test/privacy-closure.int.test.ts` ("after the grace period deletes the tenant everywhere…"), `apps/api/src/modules/privacy/company.ts` | Implemented |
| CC6.6 Boundary protection | WAF on every ALB; no public S3; private subnets | `infra/test/infra.test.ts` | Implemented |
| CC6.7 Transmission and movement of data | TLS 1.2+; residency-guarded AWS clients; exports only to the home-region store with short-lived links | `packages/core/test/residency.residency.test.ts`, `apps/api/test/privacy.residency.test.ts` | Implemented |
| CC6.8 Malicious software | Upload type, size and content validation | `apps/api/test/corehr-flows.int.test.ts` ("validates uploads by type, size and content") | Partial — no malware scanning of uploads yet (G3) |
| CC7.1 Detection of configuration changes and vulnerabilities | Dependency audit and secret scan in `pnpm verify`; CDK assertions | `scripts/secret-scan.mjs`, `infra/test/infra.test.ts` | Partial — scheduled vulnerability scanning of running infrastructure (G4) |
| CC7.2 Monitoring for anomalies | Append-only, hash-chained audit log; CloudWatch alarms | `packages/db/test/audit.int.test.ts`, `infra/lib/cell-stack.ts` | Partial — security alerting runbook and on-call (G5) |
| CC7.3–CC7.5 Incident evaluation, response and recovery | Customer incident and breach log with statutory deadlines and reminders; Thapsus-side breach register with controller notification; incident runbook | `apps/api/test/privacy-legal.int.test.ts` ("computes deadlines per jurisdiction…", "records the Thapsus-side breach register…"), `docs/runbooks/incident-and-breach-response.md` | Implemented |
| CC8.1 Change management | Branch per phase, Conventional Commits, CI gate, expand-and-contract migration lint | `packages/db/test/migrate.test.ts`, `.github/workflows/` | Implemented |
| CC9.1 Business disruption risk | Multi-AZ, continuous backups (RPO ≤ 15 minutes) | `infra/lib/cell-stack.ts` | Partial — restore and AZ drills are Phase 12 (G6) |
| CC9.2 Vendor and business partner risk | Sub-processors listed per region before integration; change notices with notice period | `docs/SUBPROCESSORS.md`, `packages/core/test/trust.test.ts` | Partial — supplier security reviews are organisational (G7) |

### Availability, confidentiality and privacy

| Criterion | Control | Evidence | Status |
| --- | --- | --- | --- |
| A1.1 Capacity | Autoscaling; load tests against brief §3 targets | `infra/lib/cell-stack.ts`, PROGRESS.md 12.1 | Partial (G6) |
| A1.2 Backup and recovery infrastructure | AWS Backup continuous and daily, copies only within the jurisdiction; backup expiry stated to customers matches infra config | `infra/test/infra.test.ts`, `packages/core/test/trust.test.ts` ("the backup expiry stated to customers matches…") | Implemented |
| A1.3 Recovery testing | Restore drill | PROGRESS.md 12.8 | Gap (G6) |
| C1.1 Identify and protect confidential information | Sensitive data vault (field-level envelope encryption, per-region KMS), category permissions, every decrypt audited | `apps/api/test/platform.int.test.ts`, `apps/api/test/privacy-dsr.int.test.ts` ("…decrypting vault values with an audit entry each") | Implemented |
| C1.2 Dispose of confidential information | Retention engine with statutory minimums and deletion log; verified deletion on closure | `apps/api/test/privacy-retention.int.test.ts`, `apps/api/test/privacy-closure.int.test.ts` | Implemented |
| P1 Notice | Employee privacy notice templates per jurisdiction (UK, EU, US), editable and published per tenant | `docs/legal/privacy-notice-*.md`, `apps/api/test/privacy-legal.int.test.ts` ("serves UK, EU and US templates…") | Implemented (templates pending legal review) |
| P2 Choice and consent | Customer is the controller; optional features (AI assistant, geofencing) off by default | `apps/api/src/modules/time/` | Partial — consent records belong to the customer |
| P3 Collection | Field-level permissions; geofence only for enabled countries | `packages/core/test/permissions.test.ts`, `apps/api/test/time.int.test.ts` | Implemented |
| P4 Use, retention and disposal | Retention rules per category and jurisdiction from the jurisdiction packs, tenant policies never below statutory minimums, legal holds, deletion log without personal data | `packages/rules/test/privacy.test.ts` ("retention"), `apps/api/test/privacy-retention.int.test.ts` | Implemented |
| P5 Access | Per-person access export (JSON and PDF); correction applied as effective-dated changes | `apps/api/test/privacy-dsr.int.test.ts` ("per-person access export", "correction workflow"), `apps/web/e2e/privacy.spec.ts` | Implemented |
| P6 Disclosure and notification | Sub-processor list and notices; breach notification deadlines (72 hours UK GDPR/GDPR; US state rules where verified) | `packages/rules/goldens/privacy.json`, `apps/api/test/privacy-legal.int.test.ts` | Implemented (some state rules unverified — see COVERAGE.md) |
| P7 Quality | Data subject correction workflow with audit | `apps/api/test/privacy-dsr.int.test.ts` ("applies the correction…") | Implemented |
| P8 Monitoring and enforcement | DSR queue with statutory deadlines, reminders and overdue notices | `apps/api/test/privacy-dsr.int.test.ts` ("sends deadline reminders once per threshold…") | Implemented |

## 2. ISO/IEC 27001:2022 Annex A

### 5 Organisational controls

| Control | Evidence | Status |
| --- | --- | --- |
| 5.1 Policies for information security | `CLAUDE.md`, `docs/SECURITY.md` | Partial — a board-approved ISMS policy set is organisational (G1) |
| 5.2–5.4 Roles, segregation of duties, management responsibilities | Back-office staff roles (super_admin, support, rules_editor, billing); support access only by customer grant | `apps/api/test/platform.int.test.ts`, `apps/api/test/rules.int.test.ts` | Partial (G1) |
| 5.7 Threat intelligence | — | Gap (G2) |
| 5.9 Inventory of information and assets | Catalog-driven table inventory (`tenantTablesInOrder`), privacy subject map | `packages/db/src/move-tenant.ts`, `apps/api/src/modules/privacy/subject-map.ts` | Implemented |
| 5.12 Classification of information | Sensitive categories held in the vault; audit diffs redact sensitive fields | `apps/api/src/modules/vault/service.ts`, `packages/db/src/audit.ts` | Implemented |
| 5.14 Information transfer | Residency guard; presigned home-region downloads; no CDN for authenticated content | `apps/api/test/privacy.residency.test.ts`, `apps/api/test/auth.int.test.ts` | Implemented |
| 5.15–5.18 Access control, identity management, authentication information, access rights | RLS, roles, MFA, SSO, SCIM, session timeouts | see CC6.1–CC6.3 | Implemented |
| 5.19–5.22 Supplier relationships and the ICT supply chain | Sub-processor list per region with notice period; lockfile pinning and dependency audit | `docs/SUBPROCESSORS.md`, `pnpm audit` in verify | Partial (G7) |
| 5.23 Information security for use of cloud services | AWS-only, regions restricted by the organisation SCP | `docs/DECISIONS.md` ADR-0001, `infra/test/infra.test.ts` | Implemented |
| 5.24–5.28 Incident management (planning, assessment, response, learning, evidence) | Incident and breach log, statutory deadlines and reminders, processor breach register, append-only audit trail for evidence | `apps/api/test/privacy-legal.int.test.ts`, `docs/runbooks/incident-and-breach-response.md` | Implemented |
| 5.29–5.30 Security during disruption, ICT readiness | Multi-AZ cells, backups | `infra/lib/cell-stack.ts` | Partial (G6) |
| 5.31 Legal, statutory, regulatory and contractual requirements | Jurisdiction packs with official sources and verification dates; DPA templates; legal review queue | `packages/rules/scripts/validate.ts`, `docs/COVERAGE.md`, `docs/HUMAN_TODO.md` §3 | Implemented (legal review pending) |
| 5.33 Protection of records | Append-only hash-chained audit log; deletion log | `packages/db/test/audit.int.test.ts` | Implemented |
| 5.34 Privacy and protection of PII | DSR tooling, retention, verified deletion, DPA, privacy notices, RoPA and DPIA drafts | `apps/api/test/privacy-*.int.test.ts`, `docs/legal/` | Implemented |
| 5.35–5.36 Independent review, compliance with policies | — | Gap — no external audit yet (G8) |
| 5.37 Documented operating procedures | Runbooks | `docs/runbooks/` | Partial — deploy, rollback and restore runbooks are Phase 12 |

### 6 People controls

| Control | Status |
| --- | --- |
| 6.1–6.8 Screening, terms of employment, awareness and training, disciplinary process, responsibilities after termination, confidentiality agreements, remote working, event reporting | Gap — organisational controls for Thapsus staff (G1). The product supports customers' own processes (onboarding, documents, e-signature). |

### 7 Physical controls

| Control | Status |
| --- | --- |
| 7.1–7.14 Physical security perimeters, entry, offices, monitoring, equipment, media, cabling, maintenance, disposal | Inherited from AWS for the service; staff equipment is organisational (G1) |

### 8 Technological controls

| Control | Evidence | Status |
| --- | --- | --- |
| 8.2 Privileged access rights | Admin MFA gate; staff TOTP; owner-only closure | `apps/api/test/auth.int.test.ts`, `apps/api/test/rules.int.test.ts` | Implemented |
| 8.3 Information access restriction | Forced RLS, field-level permissions, vault category permissions | `packages/db/test/rls.isolation.test.ts`, `packages/core/test/permissions.test.ts` | Implemented |
| 8.5 Secure authentication | Argon2id, TOTP replay protection, passkeys, lockout | `apps/api/test/auth.int.test.ts` | Implemented |
| 8.8 Management of technical vulnerabilities | `pnpm audit --audit-level high` | verify `security` step | Partial (G4) |
| 8.9 Configuration management | Infrastructure as code with assertions | `infra/test/infra.test.ts` | Implemented |
| 8.10 Information deletion | Retention engine, DSR erasure honouring legal holds and statutory minimums, verified tenant deletion including object versions and cache keys | `apps/api/test/privacy-retention.int.test.ts`, `apps/api/test/privacy-dsr.int.test.ts`, `apps/api/test/privacy-closure.int.test.ts` | Implemented |
| 8.11 Data masking | Access exports omit credentials; audit diffs redact sensitive fields; logs scrub personal data | `apps/api/test/privacy-dsr.int.test.ts`, `packages/core/test/core.test.ts` | Implemented |
| 8.12 Data leakage prevention | Residency tests for every region pair; global layer holds no personal data | `apps/api/test/residency.residency.test.ts`, `apps/api/test/privacy.residency.test.ts`, `apps/api/test/privacy-closure.int.test.ts` (directory entry check) | Implemented |
| 8.13 Information backup | AWS Backup, in-jurisdiction copies | `infra/test/infra.test.ts` | Implemented (restore drill G6) |
| 8.15 Logging | Append-only audit log, every sensitive view audited, customer export | `packages/db/test/audit.int.test.ts`, `apps/api/src/modules/audit/routes.ts` | Implemented |
| 8.16 Monitoring activities | CloudWatch, X-Ray | `infra/lib/cell-stack.ts` | Partial (G5) |
| 8.20–8.22 Network security, network services, segregation | VPC per cell, WAF, private subnets | `infra/test/infra.test.ts` | Implemented |
| 8.24 Use of cryptography | TLS; KMS per region; envelope encryption with AAD binding | `apps/api/src/lib/kms.ts`, `apps/api/test/platform.int.test.ts` | Implemented |
| 8.25–8.29 Secure development life cycle, requirements, architecture, coding, testing | Tests-first rules; contract tests; OWASP ASVS L2 target | `CLAUDE.md`, `apps/api/test/openapi.contract.test.ts`, `apps/api/test/privacy.contract.test.ts` | Partial — ASVS review is Phase 12 (G9) |
| 8.31 Separation of development, test and production | Separate environments and configs; mock IdP refused in production | `apps/api/src/deps.ts`, `infra/config/` | Implemented |
| 8.32 Change management | see CC8.1 | | Implemented |
| 8.33 Test information | Fictional test data only | `CLAUDE.md`, test fixtures | Implemented |
| 8.1, 8.4, 8.6, 8.7, 8.14, 8.17–8.19, 8.23, 8.30, 8.34 | Endpoint, source access, capacity, malware, redundancy, clock sync, privileged utilities, software installation, web filtering, outsourced development, audit testing | Mostly organisational or inherited; malware scanning G3; capacity G6 | Partial / Gap |

## 3. Gaps and owners

| Id | Gap | Owner | Next step |
| --- | --- | --- | --- |
| G1 | Organisational ISMS: policies, roles, HR security for staff, supplier policy, physical security of offices and laptops | Thapsus leadership | Write the policy set and appoint an information security owner (HUMAN_TODO) |
| G2 | Threat intelligence and the STRIDE threat model | Engineering | PROGRESS.md 12.2 |
| G3 | Malware scanning of uploaded files | Engineering | Add scanning in the home region before documents become `ready` |
| G4 | Continuous vulnerability scanning of deployed infrastructure (e.g. Amazon Inspector) | Engineering | Recurring cost, waits for approval: HUMAN_TODO 5.4 |
| G5 | Security alerting and on-call | Operations | Alarms on audit anomalies and failed logins; on-call rota |
| G6 | Load tests, restore and AZ failure drills | Engineering | PROGRESS.md 12.1 and 12.8 |
| G7 | Supplier security reviews | Thapsus leadership | Collect AWS and Stripe reports; record review dates |
| G8 | Independent SOC 2 Type I/II examination and ISO 27001 certification | Thapsus leadership | Engage an auditor after G1–G7 |
| G9 | OWASP ASVS level 2 review | Engineering | PROGRESS.md 12.3 |
