# Runbook: incident and breach response

Thapsus-HR is the **processor**; each customer is the **controller** of its employees' personal data. Our legal duty after a personal-data breach is to tell the affected controller **without undue delay**. The controller then decides about regulators and individuals. Deadlines are 72 hours under GDPR and UK GDPR from the controller becoming aware; US state rules vary. Customers usually need our help to meet those deadlines, so we move fast.

The breach register and its deadline reminders live in the product (back office → incidents; tenant admins see their own incidents under Privacy → Incidents). Deadlines and notification rules come from the jurisdiction packs (`privacy.breach_notification`), each with its official source. None are hard-coded.

## 1. Severity

| Level | Examples | Response |
| --- | --- | --- |
| SEV-1 | Confirmed or likely personal-data breach; a cross-tenant data exposure; a region-residency violation; a full outage of a cell | Page the on-call lead immediately, all hands, updates every 30 min |
| SEV-2 | Partial outage or degraded performance for many tenants; a security vulnerability being exploited without a confirmed data impact | On-call lead within 30 min |
| SEV-3 | A single feature broken, no data risk | Normal working hours |

## 2. First hour (SEV-1 and SEV-2)

1. **Declare the incident.**
   - Record the time we became aware: it starts the clocks.
   - If personal data may be involved, open a breach register entry straight away (§7, step 2).
2. **Assign roles.**
   - Incident lead decides.
   - Communications lead handles customer and status page updates.
   - Scribe keeps the timeline.
3. **Contain the incident.** Containment comes before root cause. For example:
   - revoke sessions or tokens (back office → tenant → revoke all sessions);
   - disable the affected feature flag;
   - rotate the exposed secrets in Secrets Manager and redeploy;
   - block abusive IPs in the WAF;
   - scale the worker to 0 to stop outbound deliveries.
4. **Preserve evidence.**
   - Export the relevant audit log range (`/v1/audit/events?format=json`) and the CloudWatch logs.
   - Snapshot the affected resources.
   - Never delete logs during an incident.
5. **Update the status page** for the affected regions only (`/status`). Give no personal data and no exploit details.

## 3. Is it a personal-data breach?

It is a breach if personal data was, or could have been, accessed, disclosed, altered, lost or destroyed without authorisation. Cross-tenant RLS failures, leaked exports, misdirected email and lost encryption keys all count.

- **Yes, or not yet ruled out:**
  - record it in the breach register in every affected cell (§7), which computes the controller notice deadline;
  - identify the affected tenants (controllers), and for each one, the data categories, the approximate number of people and the jurisdictions involved (from the tenants' home regions and employees' countries).
- **No:** record why, and keep the evidence.

## 4. Telling the controllers (processor duty)

- **When:** without undue delay. Internal target: first notice within 24 hours of awareness, even if incomplete, so controllers can meet their 72-hour GDPR and UK GDPR deadline. Follow up as facts arrive.
- **What to include** (GDPR Art. 33(3) content):
  - the nature of the breach;
  - the categories and approximate numbers of data subjects and records;
  - a contact point;
  - the likely consequences;
  - the measures taken and proposed.
- **How:** `notify-controllers` on the breach register entry (§7, step 4) opens an incident in each affected tenant's own incident log and notifies its owner and HR admins in the app and by email from the home region. Follow up with the customer's privacy contact, and log every further notice.
- **US employees:** the register lists each affected state's statutory notification rules from the packs (who must be told, and when). The controller decides and notifies. We give them the facts they need.
- **Regulators:** Thapsus notifies a supervisory authority directly only for its *own* data as controller (back-office staff, billing contacts). In that case: the ICO (UK) or the lead EU authority within 72 hours of awareness. Use the same register.

## 5. Recovery

1. Fix the root cause.
2. Restore data if it was damaged (`backup-restore.md`). Deploy (`deploy.md`) or roll back (`rollback.md`).
3. Verify the fix:
   - run the isolation and residency suites against the fix;
   - run `audit.verify_chain` for the affected tenants.
4. Close the status page entry. Send the controllers a final notice.

## 6. Post-incident review (within 5 working days)

- **Timeline:**
  - awareness;
  - containment;
  - controller notices sent;
  - resolved.
- **Analysis:**
  - root cause;
  - contributing factors;
  - what went well.
- **Follow-up:** action items with owners and dates, tracked as issues. Add a regression test whenever possible.
- **Records:** attach the review to the incident record. Update `docs/SECURITY.md` (threat model) if it revealed a new threat.

## 7. In the product: the processor breach register (Thapsus as processor)

Two roles apply. Each **customer is the controller** of its HR data and owns notifications to regulators and to the people affected. **Thapsus is the processor** and must tell each affected customer without undue delay (UK GDPR / GDPR Article 33(2)); the DPA drafts set a contractual target of `processorBreachNotifyHours` (48 hours, pending legal review) in `packages/core/src/trust/legal.json`.

**Proven by:** `apps/api/test/privacy-legal.int.test.ts` ("computes deadlines per jurisdiction…", "records the Thapsus-side breach register…").

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

## 8. In the product: a breach at a customer (customer as controller)

The customer logs it in **Privacy → Incidents** (`POST /v1/privacy/incidents`) with the time it became aware and the number of people affected per jurisdiction (for example `GB=40, US-CA=12`). Thapsus-HR then:

- computes each deadline from the jurisdiction packs — for example 72 hours from awareness for the regulator under UK GDPR and GDPR (Article 33), and the US state rules recorded in `docs/COVERAGE.md` (thresholds are applied to the affected counts);
- lists jurisdictions whose rules are not modelled yet, so the customer checks them with its adviser;
- sends reminders 24 and 4 hours before a deadline and when it passes (hourly `privacy.incident_reminders` job);
- records each notification made (`POST /v1/privacy/incidents/<id>/notifications`), which stops further reminders for it.

Support staff can help only through support access the customer grants (time-limited and audited).

## 9. Evidence and records

- Tenant audit log: `audit.events` (append-only, hash-chained; verify with `POST /v1/audit/verify`).
- Staff actions: `backoffice.staff_audit` (append-only).
- Breach register: `backoffice.breach_register` (no personal data).
