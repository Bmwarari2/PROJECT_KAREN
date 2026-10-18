# Thapsus-HR admin guide

For company owners, HR admins, country or entity HR admins, payroll admins and managers. It describes what Thapsus-HR does today and how to do common tasks. Screen labels are in **bold**, exactly as they appear in English (UK).

- **API only**: the feature works but has no screen yet; use the API (see [section 15](#15-integrations-and-the-api)).
- **In progress**: the code is in place but its delivery phase is not signed off yet, so details may change.
- **US workspaces** show US terms, for example **Schedule** for **Rota**, **Time clock** for **Clock in**, **Pay stubs** for **Payslips**, **Vacation** for **Annual leave** and **Organization** for **Organisation**.
- All names and examples are fictional.

## Contents

1. [Getting started](#1-getting-started)
2. [Sign-in and account security](#2-sign-in-and-account-security)
3. [Roles and permissions](#3-roles-and-permissions)
4. [People and organisation](#4-people-and-organisation)
5. [Documents and e-signing](#5-documents-and-e-signing)
6. [Onboarding, offboarding and transfers](#6-onboarding-offboarding-and-transfers)
7. [Approvals, tasks and automation](#7-approvals-tasks-and-automation)
8. [Time off and absence](#8-time-off-and-absence)
9. [Rotas, clocking in and timesheets](#9-rotas-clocking-in-and-timesheets)
10. [Compliance centre](#10-compliance-centre)
11. [Payroll handoff and payslips](#11-payroll-handoff-and-payslips)
12. [IT joiners and leavers, and equipment](#12-it-joiners-and-leavers-and-equipment)
13. [Reports and data exports (in progress)](#13-reports-and-data-exports-in-progress)
14. [Privacy and data protection](#14-privacy-and-data-protection)
15. [Integrations and the API](#15-integrations-and-the-api)
16. [Ask HR (UK workspaces only)](#16-ask-hr-uk-workspaces-only)
17. [Billing, help and support (in progress)](#17-billing-help-and-support-in-progress)
18. [Settings reference](#18-settings-reference)
19. [Where legal values come from](#19-where-legal-values-come-from)

## 1. Getting started

### Create your workspace

1. On the sign-in page, choose **Create a workspace**.
2. Under **Where should your data live?**, choose **United Kingdom (London)**, **European Union (Frankfurt)** or **United States (Ohio)**. This cannot be changed later.
3. Enter **Company name**, **Workspace** (lowercase letters, numbers and hyphens, for example `larkfield`), **Your name**, **Work email** and **Password** (at least 12 characters).
4. Tick **I accept the data processing agreement on behalf of my company.** (the agreement for your region) and choose **Create workspace**. You are now the **Company owner**.

### Data residency, in plain words

- Everything about your people stays in your home region: records, files, backups, logs, search indexes, caches, queues and emails.
- Backup copies stay in the same jurisdiction: UK backups stay in London across separate data centres; EU copies go only to Ireland; US copies go only to Northern California.
- A small global service knows only your workspace name, region, status, plan and verified domains. It holds no employee data.
- Signed-in pages and API answers come from your region and are never cached by a content delivery network.
- If someone forgets the workspace name, **Find my workspace** emails them a list from the right region.

### First steps

1. Set up two-step verification ([section 2](#2-sign-in-and-account-security)). Admin roles cannot use the app until they do.
2. Add legal entities, departments and locations in **Settings** → **Organisation structure**.
3. Add people (**People** → **Add person**, or **Imports**) and choose **Invite to sign in** on each profile.
4. Review the defaults in [section 18](#18-settings-reference).
5. For single sign-on, verify your email domain, then set up SSO and SCIM.

## 2. Sign-in and account security

### Ways to sign in

People enter their **Workspace** and **Email**, then use one of:

- **Password** and **Sign in**, then a **Six-digit code** and **Verify** if they use an authenticator app;
- **Sign in with a passkey** (fingerprint, face or device PIN), which counts as two-step verification;
- **Email me a sign-in link** (works once, expires after 15 minutes);
- **Continue with single sign-on**, if set up.

Sign-in is rate-limited per network address and per account, and repeated failures lock the account for a while.

### Two-step verification for admins

The **Company owner**, **HR admin**, **Country or entity HR admin** and **Payroll admin** must use two-step verification. Until they do, the app shows only the **Security** page. There, choose **Authenticator app** → **Set up authenticator app** (add the key, enter the code, **Verify**), or **Passkeys** → **Add a passkey**.

### Verified domains

1. Go to **Settings** → **Verified domains**, enter the **Domain** (for example `larkfield.example`) and choose **Add**.
2. Add the **DNS TXT record** shown to your DNS, then choose **Verify**. The status changes from **Pending** to **Verified**.

A verified domain lets sign-in find your workspace from an email address, and lets SSO create accounts automatically.

### Single sign-on (API only)

SAML 2.0 and OpenID Connect are supported. The company owner, signed in, uses:

1. `POST /v1/settings/sso-connections` with `protocol` (`oidc` or `saml`), a `name`, and the OIDC issuer, client ID, secret and scopes, or the SAML entry point, IdP issuer and certificate. The answer gives the ACS URL, redirect URI and entity ID for your identity provider. SAML metadata is at `/v1/auth/sso/saml/metadata/{tenantId}/{connectionId}`.
2. On first SSO sign-in, an account is created only for addresses at a verified domain, and only while `jitProvisioning` is on (the default). It gets the **Employee** role.
3. To enforce SSO, call `PATCH /v1/settings/security` with `ssoEnforced: true` (needs an enabled connection). Password, passkey and sign-in-link sign-in are then refused for everyone, so test SSO with the owner account first.

An SSO sign-in counts as two-step verification unless you set `trustIdpMfa: false`.

### SCIM provisioning (API only)

Create a token with `POST /v1/settings/scim-tokens` (shown once). Point your identity provider at `/scim/v2` on your regional API address. `Users` and `Groups` support create, read, filtered list, replace, PATCH and deactivate. SCIM users get the **Employee** role.

### Thapsus support access (API only)

Thapsus staff cannot see your data unless you grant access with `POST /v1/settings/support-grants`: the staff member's ID, `read` or `read_write`, 1 to 720 hours and a reason. Revoke with `DELETE /v1/settings/support-grants/{id}`. Everything staff do is in your audit log.

## 3. Roles and permissions

### Built-in roles

| Role                           | Scope                       | Main abilities                                                                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Company owner**              | Everyone                    | Everything, including settings, SSO, SCIM, billing, the DPA, company export, account closure and switching Ask HR on.                                                                                                                                                           |
| **HR admin**                   | Everyone                    | All HR areas: people, organisation, documents, workflows, approvals, automation, time off, rotas, time, compliance, reports, imports, exports, privacy, equipment, integrations, support, invitations, sensitive data and the audit log. Reads settings but cannot change them. |
| **Country or entity HR admin** | Their legal entity          | People, documents, workflows, approvals, time off, rotas, time, compliance, imports, exports, equipment and sensitive data. Runs reports and reads privacy requests.                                                                                                            |
| **Payroll admin**              | Everyone                    | Payroll, payslips, timesheet export and reports. Reads all employee fields; edits pay and bank fields.                                                                                                                                                                          |
| **Manager**                    | Direct and indirect reports | Approves requests, manages the rota, records sickness, corrects clock times, reads team reports and compliance status.                                                                                                                                                          |
| **Employee**                   | Themselves                  | Self-service: own details, time off, rota, swaps, clocking in, documents, payslips, equipment, support tickets and Ask HR.                                                                                                                                                      |

The first four are admin roles and need two-step verification. Everyone also has employee self-service for their own record.

### Field-level access

Each field is none, read or write. By default:

- everyone sees colleagues' directory fields: name, preferred name, job title, department, location, work email, photo and manager;
- managers also see their team's work phone, start date and status, but no personal details or pay;
- employees read their whole record, including pay, and edit their personal email and phone, address, emergency contacts, preferred name and pronouns;
- payroll admins read everything and edit pay and bank fields; HR admins edit everything in their scope.

Exports follow the same rules: columns you cannot read are blank.

### Sensitive data

Health, sickness details and fit notes, disability, diversity and EEO data, and right-to-work and immigration documents are kept in a separate store, encrypted field by field with your region's keys. Only HR admins and country or entity HR admins can read them, and every view is audit-logged. Managers can record a return-to-work conversation but cannot read medical details.

### Delegation (API only)

A manager going on holiday can hand over their team and approvals for a period with `POST /v1/delegations` (`toUserId`, `startsAt`, `endsAt`).

### Custom roles and admin role assignment

The permission engine supports custom roles with field-level access, scoped by entity, country, department or location. There is not yet a screen or public endpoint to create custom roles or to give someone an admin role. Today the workspace creator is the **Company owner**; **Invite to sign in** gives the **Employee** role; the invitation API can add **Manager** (`POST /v1/employees/{id}/invite` with `roles: ["manager"]`).

### Audit log

Every change, and every view of sensitive data, goes into an append-only, tamper-evident audit log. Export it with `GET /v1/audit/events?from=…&to=…&format=csv` (or `json`), or stream it ([section 15](#15-integrations-and-the-api)).

## 4. People and organisation

### Organisation structure

In **Settings** → **Organisation structure**, add:

- **Legal entities**: **Name**, **Country (ISO)** (for example `GB`), **Currency** (`GBP`) and **Time zone** (`Europe/London`);
- **Departments**: **Name** and **Code**;
- **Locations**: **Name**, **Country (ISO)**, **Region code** and **Time zone**.

The location's **Region code** decides public holidays and local rules:

- UK nations: `GB-ENG`, `GB-WLS`, `GB-SCT` or `GB-NIR`. Northern Ireland has its own rule pack; where a rule has not been researched yet, the app says so rather than applying Great Britain law.
- US states and cities: for example `US-CA`, or `US-NY-NYC` for New York City.

Cost centres, grades, positions, addresses and geofences are API only (`/v1/org/...`).

### Add, find and change people

- **Add a person**: **People** → **Add person**. Enter **Legal first name**, **Legal last name**, **Work email**, **Job title**, **Start date**, **Legal entity**, **Department**, **Location**, **Pay** and **Weekly hours**, then **Add to the team**. Future joiners show as **Starting soon**.
- **Give a sign-in**: on the profile, **Invite to sign in** sends a one-time link valid for 7 days (or points to SSO if enforced).
- **Find people**: search **People** by name, number, email or title, and filter by **Active**, **Starting soon**, **Left** or **All**. **Org chart** has **Find a person**, **Show team** and **Hide team**, and stays fast at very large sizes.
- **View history**: profiles have **Overview**, **History** and **Documents** tabs. **As of** shows the record on any past or future date.
- **Change a record**: choose **Make a change**, set the **Effective date**, edit the fields you may change and **Save**. Future-dated changes apply on their date. If an approval chain applies, you see **Change sent for approval**.

API only: matrix and dotted-line reporting (`/v1/employees/{id}/reporting-lines`), emergency contacts, custom fields (text, number, date, select, multi-select, yes/no, currency or file) and custom objects, and bulk edits of up to 1,000 people (`POST /v1/employees/bulk-change`).

### Import and export

1. **Imports** → **1. Upload a file**: a CSV or Excel file with a header row, up to 200,000 rows. Choose **Upload**.
2. **2. Match columns**: match each column or choose **Ignore this column**, then **Check the file**.
3. **3. Review and run**: check new, updated and problem rows. Choose **Dry run**, then **Import**. Large files run in the background; use **Download the error report** for failed rows.

Re-importing the same file changes nothing. **People**, **Tasks**, **Approvals** and **Documents** have **Export CSV** and **Export Excel**, with exactly the rows you can see, up to 10,000.

## 5. Documents and e-signing

People sign in **Documents** → **Waiting for your signature**: **Read**, **Sign**, type their full name, tick the consent box and **Sign document**. Each signature has a certificate with the signer, time (UTC), IP address, device and a SHA-256 fingerprint of the exact document.

API only:

- folders (`/v1/document-folders`) visible to `employee`, `managers`, `hr` or `everyone` (a `managers` folder hides manager notes from the person they are about);
- templates with merge fields rendered to PDF (`/v1/document-templates`);
- bulk send to a filtered group with progress (`/v1/documents/bulk-send`);
- expiry tracking with reminders (or an automation rule on **A document is expiring**).

Files are stored in your home region and checked for type and size.

## 6. Onboarding, offboarding and transfers

Workflow templates (API only, `/v1/workflow-templates`) are `onboarding`, `offboarding`, `transfer` or `custom`, with up to 100 tasks. Each task has an assignee (a role, the manager, the person or a named user), a due date relative to the start, leaving or transfer date, and a reminder (2 days before by default) plus an overdue reminder. Templates start automatically when someone is added, leaves or transfers, or with `POST /v1/workflows`.

- **Pre-start portal**: invited joiners see **Before your first day** → **Open your onboarding**, with documents to sign, personal details and emergency contact forms, and their checklist. Answers apply from the start date.
- **Leavers (API only)**: `POST /v1/employees/{id}/terminate` with `endDate`, `reason` and, for a manager, `reassignReportsTo`. This starts offboarding, adds equipment return tasks and can trigger IT leaver automation.
- **Transfers (API only)**: `POST /v1/employees/{id}/transfer` with an `effectiveDate` and the new entity, location, department, job title or manager. You need rights in the destination entity.

## 7. Approvals, tasks and automation

**Approvals**: tick requests (or **Select all**) and choose **Approve selected** or **Reject selected**. A summary shows what could not be processed.

Time off, timesheets, shift swaps and open-shift requests go to the manager by default. Employees' requests to change their legal name, date of birth or nationality (**Me** → **My details**, in progress) go to HR admins, or to the owner if there is none. Build your own chains with `POST /v1/approval-policies` (API only): up to 10 steps approved by the manager, skip-level manager, a role or a named user; conditions on fields; and a timeout per step (1 to 720 hours) with escalation.

**Tasks** shows open tasks from workflows, approvals, automation, documents and compliance. Choose **Done** when finished.

**Automation**:

1. **New rule**: enter a **Rule name** and choose **When**: **A person is added**, **A record changes**, **A date is reached** (work anniversary) or **A document is expiring** (30 days before).
2. Enter the **Create task** title and choose **Add**. The task goes to HR admins, due in 7 days.
3. Use **Dry run** to see how many people and actions it would affect.

Through `/v1/automation/rules` you can also use a threshold trigger and actions that send a notification, start a workflow, call a signed webhook or call an integration. Rules run once per event and keep an execution log.

## 8. Time off and absence

### What people see

**Time off** shows balances (**Entitlement**, **Public holidays**, **Taken**, **Booked**, **Carried over**), **Request time off**, **My requests** and **Who's away in the next 30 days**.

- Sickness, family leave and FMLA show to colleagues only as "away".
- Employees can cancel a waiting request, or an approved one before it starts. After that, HR must change it.
- **Add to my calendar** creates a private calendar (ICS) link showing approved time off as "out of office", without the type.

### Leave types and policies

On first use you get **Annual leave**, **Sickness**, **Unpaid leave**, **Family leave**, **Time off in lieu** (and **FMLA leave** in US workspaces), plus a standard annual leave policy: from the UK statutory minimum including public holidays (UK), the EU baseline (EU), or 15 days as an editable company default (US, where federal law sets no minimum).

Policies are API only (`POST /v1/leave/policies`, then `/assign`), per legal entity or country. They set accrual (up front, monthly or per hour worked), days or hours, the leave-year start, pro rata, public holidays, waiting period, carry-over with expiry, cap, negative balance and rounding. A policy below the statutory minimum is saved with a warning. Mid-year changes of policy or hours are pro-rated.

Also API only: company calendars (`/v1/settings/company-calendars`), cover rules for minimum staffing, warn or block (`/v1/leave/cover-rules`), and audited balance adjustments (`/v1/leave/adjustments`).

### Sickness

Managers and HR use **Time off** → **Record sickness**: **Employee**, **First day off**, **Last day off (if known)**.

- With a fit-note threshold set (`PUT /v1/settings/absence`, `fitNoteAfterCalendarDays`; none by default), the app says when a fit note is needed.
- Once the end date is known, the manager gets a "Return-to-work conversation" task.
- Reasons, fit notes and return-to-work answers go to the sensitive store; lists show only dates and status.
- Statutory sick pay is tracked from the packs (`/v1/sickness/{employeeId}/statutory-pay`): UK SSP using the rule in force on each day (including the April 2026 change), employer sick pay for the EU member states held, and US state and local paid sick leave accrual.

### FMLA and absence analytics

- **FMLA** cases (`/v1/fmla/cases`) check employer coverage, service, hours worked and worksite headcount from the US pack, and track intermittent leave. Set the leave-year method with `PUT /v1/settings/absence`.
- **Bradford factor** (`/v1/absence/bradford/{employeeId}`) and **trigger alerts** on a score or number of spells, sent to HR and the manager (`/v1/absence/triggers`).

## 9. Rotas, clocking in and timesheets

### Build and publish a rota

1. **Rota** → **Team rota**. Use **Previous week**, **Next week**, **This week** and **Location**.
2. **Add shift**: **Date**, **Start**, **Finish**, **Break (minutes)**, **Notes (optional)**. A finish before the start ends the next day. **Add open shift** creates a shift anyone can ask for.
3. **Apply template** creates draft shifts from a saved week; **Save as template** saves this one.
4. **Publish week** makes the dashed drafts visible and notifies each person by email and web push.

Employees **Request** open shifts and **Swap** shifts with colleagues; the colleague accepts, then the manager approves in **Approvals**. Availability is API only (`/v1/availability`); conflicts show as warnings. The rota stays responsive with 10,000+ shift workers.

### Working-time rules: warn or block

Shifts are checked against the packs: daily and weekly rest, rest breaks, the averaged maximum week, and projected US weekly and state daily overtime. Each finding links to its official source.

- **Warn** (default): the shift is saved with the findings.
- **Block**: a shift that breaks a statutory limit is refused. Swaps and claims are rechecked on approval.
- Overtime and availability are always warnings.

Set `enforcement` with `PUT /v1/settings/time` (API only). UK 48-hour opt-outs (`/v1/working-time/opt-outs`) are allowed only where the pack permits them (Great Britain). Spain and Germany have their own daily time-recording rules; other EU states follow the EU baseline, and timesheets flag scheduled days with no recorded time.

### Clocking in and geofencing

**Clock in** works offline: punches are saved on the phone and sent when it reconnects. Punches older than 72 hours or in the future are rejected.

Geofencing is **off by default**. To use it in a country:

1. Give each location a fence (latitude, longitude, 25 to 5,000 metres) through `/v1/org/locations`.
2. Call `PUT /v1/settings/time` with `geofence.countries` (for example `["GB"]`) and the `notice` text workers will see in each language. It is refused without notice text.

Workers then see **Location check at this workplace** with your notice. Location is read only at clock-in or clock-out, stored roughly (about 11 metres), never shown back and never logged. Punches outside the fence are saved and flagged **Outside the site**, not refused. Check local workplace-monitoring rules and works council duties first.

### Shared kiosks

1. **Clock in** → **Shared kiosks**: enter a **Kiosk name** and optional **Location**, then **Add kiosk**.
2. Open the pairing link on the kiosk at once (**Copy link**); it is shown only once.
3. Employees set a **Kiosk PIN** (4 to 8 digits) on **Clock in**, then use their employee number and PIN.
4. Five wrong attempts lock the PIN for 15 minutes by default. **Revoke** stops a kiosk.

Kiosks need a connection, because the PIN is checked online.

### Timesheets

**My week** compares recorded time with the rota, flags differences over 15 minutes and lists **Working-time checks**. The employee chooses **Submit week**. Managers approve or return weeks in **Team timesheets**; payroll and HR use **Export for payroll (CSV)**, which gives identical files for the same week.

Managers correct punches with `/v1/clock/corrections` (audited). Submitted or approved weeks must be reopened first (`/v1/timesheets/{id}/reopen`); exported weeks cannot be reopened.

## 10. Compliance centre

**Compliance** shows status on today's date in **Overview**, **Right to work**, **Form I-9**, **Matrix**, **Gender pay gap**, **EEO-1**, **Pay transparency** and **Law changes**. HR admins manage it; managers can read their team's status.

- **Overview**: counts by status, **Upcoming dates** (probation ends; when someone gains unfair dismissal protection), **Reporting obligations**, statutory leave coverage and US exemption checks.
- **Right to work (UK)**: **Record check** with the **Check method**, **Document list or online check result**, **Document seen**, **Date of check** and when permission ends. Follow-up and retention dates come from the Home Office guidance in the UK pack. Document details and share codes are encrypted.
- **Form I-9 (US)**: **Update** records Section 1, Section 2 and reverification dates; deadlines and retention follow the US pack.
- **Matrix**: **Add requirement** (licence, certification, background check or training) with job titles, **Valid for (months)**, **Reminder days before expiry** and evidence; then **Record** each completion.
- **Gender pay gap (UK)**: choose **Snapshot year** and **Sector** to see the six figures and whether you must report. To include bonuses, load payroll data (`PUT /v1/compliance/pay-report-inputs`, API only).
- **EEO-1 (US)**: counts by job category, race or ethnicity and sex. Self-identification is voluntary and encrypted; small counts are withheld.
- **Pay transparency (EU)**: Directive (EU) 2023/970 indicators per EU legal entity, with each state's transposition status. Gaps at or above the pack's threshold (currently 5%) are flagged for a possible joint pay assessment.
- **Law changes**: changes for places where you have entities, offices or staff, with **What to do**. **Acknowledge** records that you read one.

Reminders arrive as tasks and notifications: by default 90, 30, 7 and 0 days before right-to-work and I-9 dates, and 60, 30, 7 and 0 days before matrix expiries (`PUT /v1/settings/compliance`, API only). Checks dated before the period the packs model are refused.

## 11. Payroll handoff and payslips

Thapsus-HR does not run payroll; it prepares the inputs.

1. **Payroll** → **Pay periods**: **Period name**, **Frequency**, **First day**, **Last day**, **Add period**. While open, inputs are live: hours from approved timesheets, absences, sick pay, pay changes, starters and leavers.
2. **Close period** freezes the inputs. Closed periods cannot be reopened; correct in the next period.
3. **Connectors** → **Add connector**: **CSV file**, **Excel workbook** or **Xero Payroll (UK)**. ADP, Workday, UKG, Gusto and DATEV show **Coming soon**.
4. Export a period through a connector. Exports of a closed period are byte-identical every time, with a SHA-256 checksum.
5. Deliver by **Download**, **Send by SFTP** or **Send to payroll** (Xero); see the **Delivery log**.

Field mapping, SFTP details (with a pinned host key) and the Xero connection are API only (`/v1/payroll/connectors/{id}`). Medical details are never sent. See [docs/integrations.md](../integrations.md).

**Payslips**:

1. **Upload payslips or year-end documents**: choose **Kind**, **Document type** (for example P60, P11D, Form W-2 or Form 1099), a **Label** (for example "May 2026") and **Pay date**.
2. **Match files by** employee number in the file name, or a pattern. Add PDFs or a zip (up to 10 MB each) and choose **Upload and match**.
3. Check the matches (ambiguous names are never guessed) and choose **Publish matched**.

Each employee is notified once. Payslips are visible only to the employee and payroll, not managers, and can be withdrawn if sent in error.

## 12. IT joiners and leavers, and equipment

In **Integrations**:

1. **Microsoft 365**: enter the **Domain for new accounts** and **Microsoft Entra tenant ID**, then **Grant admin consent** (a Global Administrator approves). **Google Workspace**: enter the domain, **Google Workspace customer ID** and **Administrator to act as**; your super admin authorises the client ID under **Show delegation details**.
2. **Verify connection**.
3. **Licences and groups** → **Add rule**, matched by entity, department, location or job title.
4. **Preview the steps** (**Directory**, **Employee**, **Joining** or **Leaving**, **Preview**) shows exactly what would be sent, without contacting the directory.

Joiners are set up 3 days before their start date by default. Leavers are blocked at the end of their last working day: sign-in blocked, sessions revoked, licences removed. Hires backdated more than 7 days are never set up automatically. **Activity** lists every step.

**Equipment** → **Asset register** → **Add asset**, then **Issue** to a person, who must **Confirm receipt**. When someone leaves, offboarding adds a return task per item: **Record return**, tick the **Return checklist**, then **Mark as returned** (or **Mark as lost**).

## 13. Reports and data exports (in progress)

The screens are committed; the phase is not signed off. **Reports** appears for people who can run reports, and for managers (team reports). Reports run on a read-only copy of your data in your home region and show only the people and fields you may see; hidden values show as restricted and small counts are withheld.

- **Ready-made**: **Headcount**, **Headcount history**, **Turnover**, **Absence**, **Holiday liability**, **Overtime**, **Compliance status**, **Gender pay gap**, **EEO-1 Component 1** and **EU pay transparency**. Open one, set the **Report options** and choose **Run report**. Reports that do not apply to your countries are marked **Not used in your countries**.
- **Build a report**: choose the data (people, leave requests, sickness absence or timesheets), **People** (**Employed on the date** or **Everyone, including leavers**), a **Layout** (**List of rows** or **Summarise**), **Fields to show**, group-by levels, **Values** (**Add a calculation**), filters (**Add a filter**) and an optional bar or line **Chart**. Choose **Preview**.
- **Export** a result as **CSV**, **Excel** or **PDF**. Large exports run in the background; find them under **Exports** while they can be downloaded (168 hours by default).
- **Save report**: name it, choose **Dates when run later** (fixed or rolling, such as **Previous month**) and optionally **Share with others who can run reports**. Saved reports are under **Saved**.
- **Scheduled reports** → **Schedule a report**: a **Saved report**, **How often** (**Every day**, **Every week** or **Every month**, on day 1 to 28), **Time**, **Time zone**, **Format** and **Recipients**. Each recipient gets their own copy, limited to what they may see, and an email with a sign-in link, never the report itself. Use **Pause** and **Resume**.
- **Data exports** → **Add a destination**: an **Amazon S3 bucket** in your home region, written through an IAM role in your account whose name starts with `thapsus-hr-export-` (add the **External ID** shown to its trust policy), or an **SFTP server** with a pinned **Host key fingerprint**. Choose **Test connection**, then **Schedule an export** with the fields you want, and use **Send now** and the **Delivery log**. Each delivery uses the access rights of the person who set it up, checked again every time, and encrypted fields such as health information are never exported. The exact IAM policies are in [docs/guides/data-export.md](data-export.md).

Bradford factor in absence reports is off by default (`PUT /v1/settings/reports`, API only).

## 14. Privacy and data protection

Your company is the **controller** of its HR data; Thapsus is the **processor**. You decide how employee data is used and you answer privacy requests. **Privacy** (for HR admins) has **Requests**, **Retention**, **Incidents**, **DPA and notices** and **Export and closure**.

### Data subject requests

1. **Requests** → **Log a request**: choose **Access (copy of data)**, **Correction** or **Deletion**, **Find the person**, and enter **Date received**, **Received by** and **Identity verified by**. Describe the identity check, but never record ID numbers or document copies.
2. Choose **Log request**. The deadline comes from the law that applies to the person (UK GDPR, EU GDPR or CCPA/CPRA), with its source. Where no law covers employees, set your own target.
3. On the request: **Record verification** or **Extend deadline**; **Generate export**, then **Download JSON** and **Download PDF summary**; **Apply correction**; or **Review what will be erased**, tick **I understand this cannot be undone** and **Erase now**. Finish with **Mark completed** or **Reject request**.

Reminders go out 7, 2 and 0 days before the deadline. Erasure keeps data under a legal hold or a statutory minimum and says why; it anonymises identity and deletes files, documents and sensitive values.

### Retention

**Retention rules from the law** lists statutory minimums and suggested defaults, each with its source and marked **For legal review**. Under **Your retention policies**, set **Keep for (years)** and switch on **Delete automatically** per category. Nothing is deleted until you do. You can keep data longer than the law requires, never shorter.

**Dry run** shows the effect; **Run now** runs it. The **Deletion log** records what was deleted or kept and under which rule, without personal data. A **Legal hold** stops retention and erasure until you **Release** it.

### Incidents and breaches

**Incidents** → **Log an incident**: **What happened**, **When you became aware** (the clock starts here), people affected by jurisdiction (for example `GB=40, US-CA=12`), **Type** and **Description**. Deadlines come from the packs, such as the 72-hour regulator deadline under UK GDPR and EU GDPR, and US state rules. You get reminders, and any jurisdiction not yet modelled is listed. Choose **Mark notified** when done. Incidents Thapsus-HR reports to you appear here too.

### DPA, sub-processors and notices

- **Data processing agreement**: accepted at sign-up; the owner chooses **Accept the new DPA** for new versions.
- **Sub-processors**: **View the full list** (also public at `/trust/subprocessors`) and **Notify me of changes**. Changes are announced 30 days ahead (contractual, pending legal review).
- **Employee privacy notice**: start from your jurisdiction's template, fill in the merge fields, **Save draft** and **Publish**. Templates are drafts for legal review.

### Export and closure (company owner only)

- **Export all company data** → **Start export** → **Download**: every table as CSV, sensitive data decrypted, stored files and a manifest with checksums.
- **Close the account**: type your workspace name and choose **Schedule closure**. You can **Cancel closure** during the 30-day grace period. Then every record, file and cache entry is deleted and a deletion certificate is emailed to you. Backups expire within the stated window (35 days in production). These periods are pending legal review.

## 15. Integrations and the API

Developer documentation is in the app at **/developers** and in [docs/api.md](../api.md):

- a versioned REST API (`/v1`) described by OpenAPI 3.1, with a TypeScript SDK;
- always call your home region's API address; answers are never edge-cached;
- per-workspace rate limits, and idempotency keys on `POST` and `PATCH` kept for 24 hours;
- API keys and OAuth clients cannot call sign-in, security or settings endpoints, so the `/v1/settings` endpoints in this guide need a signed-in admin.

In **Settings** → **Integrations and platform**:

- **API access** → **Create a credential**: **Type** (**API key** or **OAuth 2.0 client (client credentials)**), **Name**, **Role** and **Scopes**. It can do only what both role and scopes allow, never more than you. Copy the secret, then **I have saved it**. **Rotate secret** keeps the old one working for 24 hours.
- **Webhooks** → **Add an endpoint**: a public `https://` **Endpoint URL** and **Events**. Deliveries are signed and retried; payloads carry identifiers and changed field names, never values. Use **Send test event**, **Delivery log** and **Replay**.
- **Audit log streaming** → **Add a stream** to an **HTTPS endpoint** or an **Amazon S3 bucket (cross-account role)** in your home region, optionally with existing history. Sensitive events are sent without values.
- **Sandboxes**: a test workspace with your configuration and up to 200 fictional people; real people, documents and sign-in methods are never copied. **Create sandbox**, then **Get sign-in link**. Your plan sets how many.
- **Branding**: a logo (PNG, JPEG or WebP, up to 512 KB) and an accent colour, refused if it fails WCAG 2.2 AA contrast in light or dark mode.
- **Features**: switch the public API, webhooks, audit streaming and branding on or off. Sandboxes and Ask HR are **Managed by Thapsus support**.

## 16. Ask HR (UK workspaces only)

Ask HR is an optional AI assistant. It answers only from the policy documents you choose, cites them, and tells people they are talking to AI. It never makes or recommends decisions about hiring, pay, performance, promotion, discipline or dismissal.

It runs only where a model is available inside your region: today that is London (Claude on Amazon Bedrock). It cannot be turned on for EU or US workspaces. It needs both your plan (set by Thapsus) and the owner's switch, and is off by default.

1. HR admins open **Settings** → **Ask HR assistant**, choose **Policy folders** visible to everyone (or **New policy folder**), add **Individual policy documents** or **Write a policy**, and choose **Save sources**.
2. Check **Indexed documents**. Personal documents (payslips, contracts, fit notes and similar) are never used; instruction-like text is removed and flagged.
3. The owner switches on **Ask HR for employees**.

It declines decision requests, questions about named colleagues and questions containing sensitive personal details. Questions and answers are not saved; only counts are kept (**Last 30 days**). Each person can ask 20 questions per 10 minutes.

## 17. Billing, help and support (in progress)

The screens are committed; the phase is not signed off.

**Billing** (company owner only):

- shows plan, term, currency, billable employees and price; prices are per active employee per month by company size, as published on **Pricing**;
- **Choose a plan** or **Change plan**: upgrades start now, prorated; downgrades and annual-to-monthly switches start at the end of the paid period; the currency is fixed once you pay;
- **Billing details** and **Add a card**: card details go to Stripe's page, and only company billing details reach Stripe, never employee data;
- **Cancel subscription** ends it after the notice period shown; **Keep my subscription** withdraws it; **Invoices** lists invoices;
- enterprise contracts (custom prices, invoicing, purchase orders, billing per entity) are set up by Thapsus.

**Help and support**:

- **Help centre** is searchable; **Help for this page** in the top bar opens articles for the current page.
- **Support** → **New ticket**: **Subject**, **Category**, **Priority** (**Urgent** is for admins), **What happened?**, optional attachment, **Send ticket**. Leave out sensitive data such as health information.
- Tickets stay in your home region. Support reads what you send in a ticket and nothing else without a support access grant. Response targets for your plan are on the **Support** page. HR admins can switch to **All company tickets**.
- Regional service status is public at **/status**.

## 18. Settings reference

| Setting                                  | Where                                                                           | Default                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| Verified domains                         | **Settings** → **Verified domains**                                             | None                                           |
| SSO connections and enforcement          | `/v1/settings/sso-connections`, `PATCH /v1/settings/security`                   | Off                                            |
| Session idle and maximum length          | `PATCH /v1/settings/security`                                                   | 30 minutes (5–720); 12 hours (1–720)           |
| Sign-in lockout                          | `PATCH /v1/settings/security`                                                   | 5 failures (3–20), 15 minutes (1–1,440)        |
| SCIM tokens, support access              | `/v1/settings/scim-tokens`, `/v1/settings/support-grants`                       | None                                           |
| Approval chains                          | `/v1/approval-policies`                                                         | Manager approves                               |
| Leave policies, cover rules, calendars   | `/v1/leave/policies`, `/v1/leave/cover-rules`, `/v1/settings/company-calendars` | Standard policy per region                     |
| Fit-note threshold, FMLA leave year      | `PUT /v1/settings/absence`                                                      | None                                           |
| Working-time rules                       | `PUT /v1/settings/time` (`enforcement`)                                         | Warn                                           |
| Geofencing per country, with notice      | `PUT /v1/settings/time` (`geofence`)                                            | Off                                            |
| Offline punches, kiosk lockout, variance | `PUT /v1/settings/time` (`clock`, `kiosk`, `timesheets`)                        | 72 hours; 5 tries, 15 minutes; 15 minutes      |
| Compliance reminders                     | `PUT /v1/settings/compliance`                                                   | 90/30/7/0 days; matrix 60/30/7/0               |
| Automation rules                         | **Automation**                                                                  | None                                           |
| Retention and legal holds                | **Privacy** → **Retention**                                                     | Automatic deletion off                         |
| Reports                                  | `PUT /v1/settings/reports`                                                      | Bradford factor off; results kept 168 hours    |
| API, webhooks, streams, branding, Ask HR | **Settings** → **Integrations and platform**                                    | See [section 15](#15-integrations-and-the-api) |

## 19. Where legal values come from

Thapsus-HR never hard-codes employment law. Statutory values (annual leave minimums, sick pay, working-time limits, overtime, right-to-work and I-9 rules, privacy deadlines and retention periods) come from versioned, effective-dated rule packs:

- **UK**: a Great Britain pack, where each rule lists the nations it covers, and a separate Northern Ireland pack;
- **EU**: an EU baseline plus all 27 member states (public holidays for Lithuania, Romania and Cyprus are still to be added);
- **US**: federal rules, a state layer (California, Colorado, Florida, Georgia, Illinois, Massachusetts, New York, Oregon, Texas, Washington) and New York City.

Each value carries its official source and the date it was checked, and the app shows the source beside results such as working-time findings, privacy deadlines and compliance dates. All values are pending legal review. Coverage is in [docs/COVERAGE.md](../COVERAGE.md). The packs say what the law is; they are not legal advice, so check important decisions with your adviser.
