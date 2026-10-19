# Runbook: incident and breach response

Two roles apply. Each **customer is the controller** of its HR data and owns notifications to regulators and to the people affected. **Thapsus is the processor** and must tell each affected customer without undue delay (UK GDPR / GDPR Article 33(2)); the DPA drafts set a contractual target of `processorBreachNotifyHours` (48 hours, pending legal review) in `packages/core/src/trust/legal.json`.

**Proven by:** `apps/api/test/privacy-legal.int.test.ts` ("computes deadlines per jurisdiction…", "records the Thapsus-side breach register…").

## A. A security event inside Thapsus-HR (Thapsus as processor)

1. **Contain.** Revoke the affected credentials or sessions, isolate the resource and preserve evidence. Never delete logs or audit rows; the tenant audit log is append-only.
2. **Record it in the breach register** in the affected cell (staff with `support` or `super_admin`). Describe what happened without any personal data:
   ```
   POST /v1/backoffice/breaches
   { "title": "...", "summary": "...", "awareAt": "<ISO instant>", "affectedTenantIds": ["..."], "dataCategories": ["..."] }
   ```
   The register stores tenant ids and categories only, and computes `controllersNotifyBy` from `awareAt`.
3. **Assess** which tenants and data categories are affected. Repeat step 2 in each cell; a tenant id from another cell is reported as `notInThisCell`.
4. **Notify the controllers** before `controllersNotifyBy`:
   ```
   POST /v1/backoffice/breaches/<id>/notify-controllers
   ```
   This opens an incident (source `processor`) in each affected tenant's own incident log and notifies its owner and HR admins in the app and by email from the home region. Follow up with the customer's privacy contact with what you know, and keep updating them.
5. **Close.** Update the status, write a post-incident review and add any control changes to `docs/SECURITY.md` and `docs/COMPLIANCE.md`.

## B. A personal data breach at a customer (customer as controller)

The customer logs it in **Privacy → Incidents** (`POST /v1/privacy/incidents`) with the time it became aware and the number of people affected per jurisdiction (for example `GB=40, US-CA=12`). Thapsus-HR then:

- computes each deadline from the jurisdiction packs — for example 72 hours from awareness for the regulator under UK GDPR and GDPR (Article 33), and the US state rules recorded in `docs/COVERAGE.md` (thresholds are applied to the affected counts);
- lists jurisdictions whose rules are not modelled yet, so the customer checks them with its adviser;
- sends reminders 24 and 4 hours before a deadline and when it passes (hourly `privacy.incident_reminders` job);
- records each notification made (`POST /v1/privacy/incidents/<id>/notifications`), which stops further reminders for it.

Support staff can help only through support access the customer grants (time-limited and audited).

## C. Evidence and records

- Tenant audit log: `audit.events` (append-only, hash-chained; verify with `POST /v1/audit/verify`).
- Staff actions: `backoffice.staff_audit` (append-only).
- Breach register: `backoffice.breach_register` (no personal data).
