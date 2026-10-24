# Integrations: payroll handoff, payslips, IT automation and assets

Thapsus-HR never runs payroll. It hands each pay period's inputs to the customer's payroll, publishes the payslips payroll produces, and keeps the customer's Microsoft 365 or Google Workspace directory in step with joiners and leavers. This page describes the connectors, the data that flows, where it goes and the permissions involved. Decisions are in DECISIONS.md (ADR-0060 to ADR-0066); third parties are listed per region in SUBPROCESSORS.md.

## Ground rules

- **The customer is the controller and turns each integration on.** Nothing is sent until a customer admin creates and enables a connector or connects a directory, and (where the provider supports it) grants admin consent.
- **Only listed destinations.** Outbound HTTPS goes through an allow-list (`apps/api/src/modules/integrations/http.ts`): Microsoft Graph and identity, Google Admin SDK, Licensing and OAuth, Xero API and identity. A unit test fails if a host there is missing from SUBPROCESSORS.md. SFTP goes only to the host the customer configures, with its host key pinned.
- **From the home region.** Exports are built and stored in the tenant's home-region cell and object store (presigned links expire after five minutes). Calls to providers leave from the home region.
- **Secrets sealed.** OAuth refresh tokens, client secrets, service-account keys and SFTP passwords or keys are stored in `app.integration_credentials` as one envelope per integration: a fresh data key wrapped by the cell's regional KMS key, AES-256-GCM, bound to tenant and integration. The API only ever reports which secrets are configured, never their values. Audit entries record secret names only. Reporting replicas cannot read the table.
- **Data minimisation.** A payroll export contains exactly the fields in the connector's mapping. Sickness reasons, fit notes and every other vault value are never part of payroll inputs. Directory calls send names, work email, job title, department and country only.
- **Everything is logged.** Every export, download, delivery and directory call has a row in a log table and an audit event; views of payroll inputs and payslip downloads are audited as sensitive.

## Payroll handoff (PROGRESS 6.1, 6.2)

### Data flow

1. A payroll admin creates **pay periods** (weekly to monthly, company-wide or per legal entity; periods for the same entity cannot overlap).
2. While a period is open, its **inputs** are computed live from the HR records:
   - **hours**: approved timesheets whose week starts in the period, split into regular, overtime and double time;
   - **absences**: approved leave of every type (including sickness) overlapping the period, clipped to the period, with working days recalculated for the clipped part;
   - **sick pay**: UK statutory sick pay payable for days in the period, from the GB pack rule `sick_pay.statutory` (flat rate, or the lower of the rate and 80% of normal weekly earnings from 6 April 2026), with the source URL;
   - **pay changes**: effective-dated pay records starting in the period, with the previous amount;
   - **starters** and **leavers**: start date or last working day in the period.
3. **Closing** a period freezes the inputs in an append-only snapshot (`app.pay_period_snapshots`, SHA-256 of the canonical JSON). Closed periods cannot be reopened or moved; corrections go in the next period.
4. An **export** renders the inputs through a connector and stores the file. Exports of a closed period are rebuilt from the snapshot, so the same connector configuration always produces **byte-identical files** (no current timestamps; zip entry dates and workbook properties are pinned to the period end). Each export records the file hash, the inputs hash and the connector configuration hash.
5. **Delivery**: download (a five-minute presigned link, logged as a delivery), SFTP upload or API push (background jobs, idempotent per delivery; items already accepted by the provider are never sent again).

### Field mapping

Each connector has a per-tenant mapping: for each section (hours, absences, sick pay, pay changes, starters, leavers) an ordered list of columns, each either a Thapsus field or a fixed value, with an optional transform:

| Transform           | Applies to | Example                                                                          |
| ------------------- | ---------- | -------------------------------------------------------------------------------- |
| `date`              | dates      | `dd/MM/yyyy`, `MM/dd/yyyy`, `yyyyMMdd`, `dd.MM.yyyy`, `dd-MM-yyyy`, `yyyy-MM-dd` |
| `hours` / `minutes` | durations  | hours with 0–4 decimals, or whole minutes                                        |
| `number`            | numbers    | 0–4 decimals                                                                     |
| `money`             | amounts    | major units (`1234.56`) or minor units (`123456`)                                |
| `codeMap`           | text       | leave type `annual` → `HOL`, with a default                                      |
| `boolean`           | yes/no     | `Y` / `N`                                                                        |
| `case`              | text       | upper or lower case                                                              |

File options: date format, decimal separator, delimiter and header row. `GET /v1/payroll/catalogue` lists every field per section; nothing outside the catalogue can be exported. Text cells that start with `= + - @` are prefixed with `'` (CSV/Excel formula injection guard).

<a id="generic-csv-and-excel"></a>

### Generic CSV and Excel

- **CSV**: one file per enabled section; one section gives a plain `.csv`, several give a `.zip` of CSVs (`hours.csv`, `absences.csv`, `sick_pay.csv`, `pay_changes.csv`, `starters.csv`, `leavers.csv`).
- **Excel**: one `.xlsx` with one sheet per section and typed number cells.
- Either can be delivered by download or to the customer's SFTP host. The "SFTP connector" is one of these formats over the SFTP transport:
  - The customer gives the host, port, user, directory and the server's **host key fingerprint** (`SHA256:…`, as `ssh-keygen -lf` prints it). A mismatch aborts before authentication.
  - Password or private-key authentication; the secret is sealed.
  - Private, loopback, link-local and CGNAT addresses are refused outside dev and test. The name is resolved once and the connection goes to that address.
  - The file is written as `.<name>.part` and renamed into place; a re-delivery replaces it.

<a id="xero-payroll-uk"></a>

### Xero Payroll (UK)

UK workspaces only (Xero Payroll UK serves UK employers). Endpoints follow Xero's official OpenAPI description of the Payroll UK API (`https://api.xero.com/payroll.xro/2.0`, header `Xero-Tenant-Id`, `Idempotency-Key` per record):

- `POST /Timesheets`: one timesheet per employee for the pay period, one line per week and earnings rate (regular, overtime and double time map to the customer's Xero earnings rates).
- `POST /Employees/{EmployeeID}/Leave`: each absence, with the customer's Xero leave type and a short description (never medical detail).
- `GET /Employees`: used to match employees by employee number when the mapping does not name the Xero employee id.

Connecting:

- **OAuth 2.0 authorisation code** with the Thapsus Xero app. Scopes are `offline_access payroll.timesheets payroll.employees`, with a single-use state. Refresh tokens rotate on every use and are re-sealed.
- Or a **Xero custom connection** (client credentials) entered by the customer.

Unmapped earnings rates, leave types or employees are listed in the export (`unmapped`) and in the delivery log as skipped. They are never guessed. Starters, leavers, pay changes and SSP stay in the downloadable document for the payroll team. Xero's statutory sick leave endpoint needs medical flags that Thapsus-HR does not send.

### Documented stubs

These connectors implement the interface (they can be listed and configured, disabled) but refuse to render or push with HTTP 501 and a pointer here, until the partner programme in HUMAN_TODO.md section 4 is complete and the integration is added to SUBPROCESSORS.md. Meanwhile customers use the generic CSV or Excel connector with a mapping in the provider's import layout.

<a id="adp"></a>

- **ADP** (Workforce Now / iHCM): needs the ADP Marketplace partner programme (API credentials and certificate per customer). Planned: worker hours and time-off via ADP's Payroll Input APIs.

<a id="workday"></a>

- **Workday Payroll**: needs the Workday Partner Network, or a customer-sponsored Integration System User. Planned: Workday Web Services / REST Payroll Input.

<a id="ukg"></a>

- **UKG** (Pro / Ready): needs the UKG partner programme. Planned: time and pay import APIs.

<a id="gusto"></a>

- **Gusto** (US only): needs the Gusto Embedded partner programme. Planned: payroll hours and time off through Gusto's partner API.

<a id="datev"></a>

- **DATEV** (Germany, EU workspaces only): needs DATEV Marktplatz partnership. Planned: DATEV Lohn und Gehalt import (ASCII/LODAS formats) or DATEVconnect.

## Payslips and year-end documents (PROGRESS 6.3)

1. A payroll admin uploads PDFs or a zip of PDFs as one **batch**: payslips or a year-end document such as a P60, P11D, W-2, 1099 or annual statement.
2. **Matching** links each file to an employee:
   - by **employee number**: any whole token in the file name, case-insensitive (`PAY-1001_2026-05.pdf`);
   - or by a **file-name pattern**: a regex whose named group `employeeNumber` or first group is the number.
3. The **preview** lists each file as matched, unmatched or ambiguous. Ambiguous names are never guessed. Files that are not PDFs, duplicates and oversized archive entries are rejected.
4. Files can be matched or unmatched by hand, then **published**. Each employee gets one in-app and email notification per document.
5. Storage and access:
   - Files live in the home-region bucket under the tenant prefix.
   - They are **restricted**: outside the general document library, invisible to managers, and visible only to the employee and payroll roles (`payslips.*`).
   - Downloads use five-minute presigned links and are audited as sensitive.
   - A document sent in error can be withdrawn. Discarding a draft batch deletes its files.

### Structured statements from the payroll provider (ADR-0167)

Thapsus-HR never calculates pay, tax or deductions. A provider can send each payslip's content as data, so employees get an accessible, printable payslip instead of only a PDF:

1. **Upload.** The same batch upload takes one extra multipart part, `statements`: a JSON file in the `StatementImport` format (`apps/api/src/modules/payslips/statement.ts`, published in the OpenAPI document). The batch kind must be `payslip`. PDFs can be sent in the same request; a PDF matched to the same person is kept as the provider's copy of that statement.
2. **Format.**
   - The file: `provider.name`, optional `sample`, and up to 5,000 `statements`.
   - Each statement:
     - `employeeNumber` (matched like file names) and `currency` (ISO 4217);
     - `employer` (name, address, tax reference) and `employee` (name, address, department, job title, tax code, national identifier);
     - `period` (start, end, pay date, frequency, the provider's period label, tax year) and `payment` (method, account);
     - `payments`, `deductions` and `employerContributions` lines (kind, label, optional quantity and rate);
     - `totals` (gross, deductions, net), `ytd` items and up to five `notes`.
   - Every amount is an integer in minor units.
3. **Checks.** A file that is not valid JSON or does not match the format is refused as a whole, with the first 20 schema errors. A single statement is refused, and listed in the preview with its reason, when:
   - its dates are not calendar dates in order (`periodInvalid`);
   - its lines do not add up to the provider's totals (`paymentsDoNotAddUp`, `deductionsDoNotAddUp`, `netDoesNotAddUp`);
   - the same person appears twice in one upload (`duplicate`).

   Unknown employee numbers are left unmatched, as for files.

4. **What is stored.** The statement is kept as received, except:
   - the national identifier, kept masked (`•••• 456C`);
   - the bank account, kept as its last four digits (`•••• 5678`).

   The pay date, period, currency, gross and net are copied to columns for listing.

5. **What employees see.**
   - `/app/payslips` lists payslips by year with the year-to-date figures of the year's latest statement.
   - `/app/payslips/:id` shows the statement with a print style, opens the provider's PDF in the viewer, and downloads the provider's PDF or, when none was sent, a PDF of the statement (`GET /v1/payslips/:id/pdf`).
   - Every view and download is audited as sensitive.
   - The publish notification names the period in the reader's locale ("Your payslip for August 2026 is ready").
6. **Sample data.** The staging workspace's payslips come from a fictional "sample payroll provider" fixture (`apps/api/src/cli/staging/sample-payroll-provider.ts`). Its figures are hand-written and illustrative, never derived from tax rules, and the app marks them "Sample data" with the provider's name.

## Joiner and leaver IT automation (PROGRESS 6.4)

<a id="microsoft-365"></a>

### Microsoft 365 (Microsoft Graph)

- **Consent**:
  - The customer's Global Administrator (or Privileged Role Administrator) grants **admin consent** to the Thapsus multi-tenant Entra app through the v2 admin-consent link (single-use state). Thapsus records the customer's Entra tenant id.
  - Customers may instead register their own app and enter its client id and secret (sealed).
  - "Verify" proves the consent by obtaining a client-credentials token for that tenant.
- **Least-privilege application permissions**, per call:

  | Permission                        | Used for                            |
  | --------------------------------- | ----------------------------------- |
  | `User.Create`                     | Create the account                  |
  | `User.Read.All`                   | Look up an existing account by name |
  | `User.EnableDisableAccount.All`   | Block sign-in                       |
  | `User.RevokeSessions.All`         | Revoke sessions                     |
  | `LicenseAssignment.ReadWrite.All` | Assign and remove licences          |
  | `GroupMember.ReadWrite.All`       | Add to groups                       |

  Blocking sign-in for privileged users also needs an Entra admin role assigned to the app; this is documented for customers and is never granted by default.

- **Joiner calls**:
  - `POST /users` (display name, given name, surname, user principal name, mail nickname, employee number, job title, department, usage location, a one-time password with forced change);
  - `POST /users/{upn}/assignLicense`;
  - `POST /groups/{id}/members/$ref`.
- **Leaver calls**:
  - `PATCH /users/{upn}` `{accountEnabled:false}`;
  - `POST /users/{upn}/revokeSignInSessions`;
  - `POST /users/{upn}/assignLicense` to remove the licences.

<a id="google-workspace"></a>

### Google Workspace (Admin SDK)

- **Consent**: the customer's super admin authorises the Thapsus service account's client id for domain-wide delegation with exactly these scopes, and names an admin to act as:
  - `https://www.googleapis.com/auth/admin.directory.user`
  - `https://www.googleapis.com/auth/admin.directory.user.security`
  - `https://www.googleapis.com/auth/admin.directory.group.member`
  - `https://www.googleapis.com/auth/apps.licensing`

  The service-account key is sealed. "Verify" signs an RS256 JWT bearer assertion and exchanges it.

- **Joiner calls**:
  - Directory `users.insert` (primary email, name, one-time password with forced change, organisational unit, employee number as an external id, title and department);
  - License Manager `licenseAssignments.insert`;
  - Directory `members.insert`.
- **Leaver calls**: `users.patch` `{suspended:true}`, `users.signOut`, and `licenseAssignments.delete`.

### How it runs

- **Mapping rules** per connection match on legal entity, department, location and job title, and add licences, groups and (for Google) an organisational unit.
- **Dry run**: `GET /v1/integrations/it/{provider}/preview/{employeeId}?lifecycle=joiner|leaver` returns the exact calls (method, URL, body) without contacting the provider. Execution stores and runs that same plan. Only the generated password, which is never stored or logged, and the new account id are filled in at run time.
- **Triggers**: outbox events `employee.created` and `employee.terminated` enqueue idempotent jobs (one idempotency key per employee, lifecycle and date):
  - joiners run a configurable number of days before the start date (default 3);
  - leavers run at the end of the last working day in the employee's time zone, or immediately if the customer chooses;
  - hires backdated by more than seven days, for example an import of current staff, are never provisioned automatically.
- **Idempotency and safety**:
  - Every call has a row in `app.it_operations` with its own idempotency key, so a re-run skips completed calls.
  - Joiner calls stop at the first failure.
  - Leaver calls each run regardless, so a failed licence removal never leaves sign-in open.
  - An existing account is adopted only if it carries the same employee number.
  - A leaver with no account that Thapsus created, and no matching work email, is skipped rather than matched to a generated name.
- **Logs**: `GET /v1/integrations/it/operations` lists the provider calls with their status. The audit log has `it.joiner_executed` and `it.leaver_executed` with counts.

## Asset register (PROGRESS 6.5)

- **Assets**: tag, type, name, serial number, purchase cost in integer minor units with its ISO currency, status, legal entity and location. Each has a **return checklist**: defaults per type, such as device, charger and data wiped for a laptop, or customer-defined items.
- **Handover**:
  - Issuing an asset creates a task and a notification for the employee.
  - Only the employee can **acknowledge** the handover. The sign-off records the time (server clock), the user, IP address, user agent and the version of the statement shown.
- **Return**:
  - When an **offboarding workflow** starts, one return task per issued asset is added to it, assigned to HR (configurable with `features.assets.returnAssigneeRole`) and due on the leave date.
  - Recording the return needs every checklist item ticked, or "lost". It completes the task, and the workflow completes when its other tasks are done.

## Permissions

| Action                                     | Built-in roles            |
| ------------------------------------------ | ------------------------- |
| `payroll.read`                             | HR admin, payroll admin   |
| `payroll.manage`, `payroll.export`         | Payroll admin (owner)     |
| `payslips.manage`, `payslips.read`         | Payroll admin             |
| `payslips.read_own`                        | Everyone (self-service)   |
| `integrations.read`, `integrations.manage` | HR admin (owner)          |
| `assets.read`, `assets.manage`             | HR admin, entity HR admin |
| `assets.read_own`, `assets.acknowledge`    | Everyone (self-service)   |
