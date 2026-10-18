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
   - Open an incident record in the back office (type, cells affected, time we became aware).
   - The awareness time starts the clocks.
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
  - mark the incident as a *breach* in the register, which starts the per-controller reminders;
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
- **How:** email to the tenant's DPA contacts and owners from the tenant's home region, plus an in-app notice. Log every notice in the incident record.
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
