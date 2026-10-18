# Records of processing activities — Thapsus-HR as processor (Article 30(2))

> **DRAFT — for legal review.** Prepared on 2026-10-18 from UK GDPR / GDPR Article 30 (https://www.legislation.gov.uk/eur/2016/679/article/30). Not legal advice; review required before use (docs/HUMAN_TODO.md 3.3). Items in `[brackets]` need a decision or a name.

Article 30(2) requires a processor to keep a record of all categories of processing carried out on behalf of each controller. Thapsus keeps this record per regional cell, because each customer's data stays in its home region. The list of customers (controllers) is generated from the regional tenant registry and is not reproduced in this document.

## 1. Processor

| Item | Entry |
| --- | --- |
| Name | Thapsus `[legal entity name and registered number]` |
| Contact | `privacy@[THAPSUS_HR_DOMAIN]` (the product domain is configuration and not chosen yet) |
| Data protection officer | `[name or "not designated" with reasons]` |
| UK representative / EU representative (Art. 27) | `[if required for the legal entity's establishment]` |

## 2. Controllers on whose behalf Thapsus processes

Every customer workspace (tenant). For each, the record holds: tenant id, legal name, home region, date the DPA was accepted and its version (`app.dpa_acceptances`), and the customer's privacy contact. Export: back office → tenants (staff access is audited).

## 3. Categories of processing carried out for each controller

| Category | Description | Personal data | Data subjects |
| --- | --- | --- | --- |
| Hosting and storage | Storing HR records, documents and files in the home region | All data the customer enters | Employees, workers, contractors, leavers, emergency contacts |
| Core HR | Effective-dated records, organisation, reporting lines | Identity, contact, job, pay, contract | Employees, workers |
| Time off and absence | Balances, requests, sickness records, statutory leave | Leave and sickness data (sickness detail in the encrypted vault) | Employees, workers |
| Rotas and time | Shifts, clock events (optional geofence), timesheets | Working time, optional location at clock-in | Employees, workers |
| Documents and e-signature | Folders, templates, signatures with audit trail | Document contents, signer name, time, IP, document hash | Employees |
| Payroll handoff | Exports to the customer's payroll provider on its instruction | Fields chosen in the connector mapping | Employees |
| Joiner and leaver IT automation | Account creation and removal in the customer's own Microsoft 365 / Google Workspace | Name, work email, job, manager, dates | Employees |
| Privacy operations | Data subject requests, retention, exports, account closure, incident log | As required to fulfil each request | Employees and requesters |
| Notifications | In-app, email (Amazon SES in region) and web push | Recipient address and message content | Users |
| Security and audit | Authentication, sessions, audit log | Email, IP address, user agent, actions | Users |
| Support | Only through customer-granted, time-limited, audited access | Data visible on the screens support is shown | Users and employees |

## 4. Transfers to third countries

| Home region | Where data is processed | Backup copies | Transfer mechanism |
| --- | --- | --- | --- |
| UK | AWS eu-west-2 (London) | London only, across availability zones | None — no transfer |
| EU | AWS eu-central-1 (Frankfurt) | eu-west-1 (Ireland) | None — stays in the EU |
| US | AWS us-east-2 (Ohio) | us-west-1 (N. California) | None — stays in the US |

Sub-processor access from outside the region (for example AWS or Stripe support) is governed by the sub-processor's own terms, listed in docs/SUBPROCESSORS.md. `[Legal to confirm whether any remote access by sub-processor personnel is a restricted transfer and which safeguard applies.]`

## 5. Security measures (general description)

See docs/SECURITY.md for the controls and the tests that prove them. In summary: tenant isolation with forced row-level security; envelope encryption with regional KMS keys for sensitive data; TLS 1.2+; MFA for administrators; least-privilege IAM; append-only, hash-chained audit log; residency guard on every AWS client; continuous backups with an RPO of 15 minutes or better; verified deletion on account closure.

## 6. Time limits for erasure (Article 30(1)(f) — for controller records)

Customers decide retention. The retention engine applies statutory minimums from the jurisdiction packs and the customer's own periods, and keeps a deletion log of category, count, date and rule version. Backups expire on their own schedule after deletion (docs/runbooks and the deletion certificate state the window).

## 7. Thapsus as controller (separate record)

Thapsus is a controller for its own customer-account and billing data (account owner name, billing email, company address) and for staff accounts in the back office. `[Legal to complete a separate Art. 30(1) record for these activities.]`
