# Data protection impact assessment (DPIA) template — Thapsus-HR

> **DRAFT — for legal review.** Prepared by the engineering team on 2026-10-18 from the text of UK GDPR / GDPR Article 35 (https://www.legislation.gov.uk/eur/2016/679/article/35). Not legal advice. A qualified data protection lawyer must review it before any customer relies on it (docs/HUMAN_TODO.md 3.3).

Each customer is the **controller** of its HR data and owns its DPIA. Thapsus-HR is the **processor** and provides this template, pre-filled with the facts about the service, to help the customer complete it. Sections marked *(customer)* must be completed by the customer.

## 1. When a DPIA is needed

Article 35(1) requires a DPIA before processing that is likely to result in a high risk to people's rights and freedoms. Article 35(3) lists cases where one is always required, including large-scale processing of special category data (Article 9(1)) or criminal offence data (Article 10). HR systems usually hold health, sickness, disability and diversity data, so most customers should complete one. Supervisory authorities also publish their own lists of processing that needs a DPIA. Check the list of the authority that regulates you *(customer)*.

## 2. Description of the processing (Article 35(7)(a))

| Item | Pre-filled facts about Thapsus-HR | Customer input |
| --- | --- | --- |
| Purposes | Core HR records, organisation charts, documents and e-signature, time off and absence, rotas and time tracking, payroll handoff exports, joiner/leaver IT automation, reports, employee self-service. | Which modules you use and why *(customer)* |
| Lawful bases | Not decided by Thapsus-HR. | For example contract, legal obligation or legitimate interests (Art. 6), plus an Art. 9 condition for special category data *(customer)* |
| Data subjects | Employees, workers, contractors, leavers, emergency contacts and (optionally) dependants. | *(customer)* |
| Personal data | Identity and contact details, job and pay history, contracts, leave, sickness and fit notes, working time and clock-ins (optionally with location if the customer turns on geofencing for a country), right-to-work documents, diversity and EEO self-identification, documents and signatures, audit trails. | Remove modules you do not use *(customer)* |
| Special category data | Stored in a separate vault, encrypted per value with a regional KMS key; every access is logged. | Which categories you collect *(customer)* |
| Scale | The service is built for 10 to 200,000+ employees per customer. | Your headcount and countries *(customer)* |
| Location | All personal data stays in the home region chosen at sign-up: UK = AWS eu-west-2 (London), EU = eu-central-1 (Frankfurt), US = us-east-2 (Ohio). Backup copies only within the same jurisdiction (EU → eu-west-1, US → us-west-1; UK backups stay in London). | *(customer)* |
| Recipients | Sub-processors listed per region at `/trust/subprocessors` (generated from docs/SUBPROCESSORS.md). Integrations the customer turns on (Microsoft 365, Google Workspace, payroll providers, SFTP/S3, SIEM) receive the fields the customer chooses. | Your own recipients *(customer)* |
| Retention | The retention engine applies the statutory minimums held in the jurisdiction packs and the customer's own policies; suggested defaults are marked for legal review. | Your retention schedule *(customer)* |

## 3. Necessity and proportionality (Article 35(7)(b))

*(customer)* Explain why each category of data is needed for the purpose, why less intrusive options are not enough, how employees are informed (see the privacy notice templates in docs/legal/), and how data subject rights are handled (Thapsus-HR provides access exports, correction and deletion workflows with statutory deadlines).

Product features that support proportionality:

- Geofencing for clock-in is **off by default** and must be enabled per country with a notice to staff.
- Managers see only their team and only the fields their role allows (field-level permissions).
- Sickness and family-leave details are hidden from colleagues and calendar feeds.
- The optional AI assistant is off by default and never receives sensitive data.

## 4. Risks to individuals (Article 35(7)(c))

| Risk | Likelihood *(customer)* | Severity *(customer)* | Built-in mitigations |
| --- | --- | --- | --- |
| Unauthorised access by another customer | | | PostgreSQL row-level security enabled and forced on every table, proven by an automated test that enumerates the catalog |
| Unauthorised internal access | | | Role-based and field-level permissions, MFA for admins, SSO enforcement, session timeouts, append-only audit log |
| Exposure of special category data | | | Separate encrypted vault, per-category permissions, every decrypt audited |
| Transfer outside the jurisdiction | | | Residency-guarded AWS clients, start-up endpoint checks, residency tests for every region pair |
| Excessive retention | | | Retention engine with dry run and deletion log; legal holds |
| Loss of data | | | Multi-AZ database, continuous backups (RPO 15 minutes or better), backup copies within the jurisdiction only |
| Breach not reported in time | | | Incident and breach log with statutory deadlines from the jurisdiction packs and reminders |

## 5. Measures to address the risks (Article 35(7)(d))

*(customer)* List the measures you will take in addition to the built-in ones, who owns them and by when. Typical items: role design, training for HR staff, reviewing the retention schedule, enabling SSO, reviewing sub-processors.

## 6. Consultation and sign-off

| Step | Name and role | Date | Outcome |
| --- | --- | --- | --- |
| Data protection officer advice (Art. 35(2)) | | | |
| Views of employees or their representatives, where appropriate (Art. 35(9)) | | | |
| Residual risk accepted by | | | |
| Prior consultation with the supervisory authority needed (Art. 36)? | | | |
| Review date | | | |
