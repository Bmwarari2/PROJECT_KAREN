# Data processing agreement — European Union (GDPR)

> **DRAFT — for legal review.** Version 2026-10-18. Drafted by the engineering team from GDPR Article 28 (https://eur-lex.europa.eu/eli/reg/2016/679/oj) and the product's actual controls. Not legal advice. It must be reviewed by a qualified EU data protection lawyer before it is offered to customers (docs/HUMAN_TODO.md 3.3). Customers accept the current version in the product (Privacy → Legal); acceptance is recorded with the version, the user and the time, and a new version must be accepted again.

This agreement forms part of the terms between the customer (**Controller**) and Thapsus `[legal entity]` (**Processor**) for the Thapsus-HR service, for workspaces whose home region is the **European Union (AWS eu-central-1, Frankfurt)**.

## 1. Subject matter, duration, nature and purpose

- **Subject matter:** hosting and operating the Thapsus-HR service for the Controller's workforce.
- **Duration:** for the term of the subscription and until deletion is completed under clause 10.
- **Nature and purpose:** storage, organisation, retrieval, transmission on the Controller's instructions, and deletion of HR data, as described in the records of processing (docs/legal/records-of-processing.md).
- **Types of personal data:** identity and contact details, employment, pay and contract records, leave and absence, working time, documents and signatures, and — where the Controller uses those features — special category data (health, sickness, disability, diversity) and right-to-work documents.
- **Data subjects:** the Controller's employees, workers, contractors, former staff and their emergency contacts.

## 2. Instructions (Art. 28(3)(a))

The Processor processes personal data only on the Controller's documented instructions: this agreement, the Controller's configuration of the service and actions taken by its authorised users. If the law requires other processing, the Processor will tell the Controller first unless the law forbids it. The Processor will tell the Controller immediately if it believes an instruction infringes data protection law.

## 3. Confidentiality (Art. 28(3)(b))

Everyone authorised to process the data is bound by confidentiality. Thapsus staff can reach customer data only through support access that the Controller grants, which is time-limited (at most 30 days), revocable and audit-logged in the Controller's own audit log.

## 4. Security (Art. 28(3)(c) and Art. 32)

The Processor implements the measures in docs/SECURITY.md, including: row-level tenant isolation proven by automated tests; field-level encryption of special category data with an EU-region KMS key; MFA for administrators; an append-only audit log the Controller can export; continuous backups with copies only in AWS eu-west-1 (Ireland).

## 5. Sub-processors (Art. 28(2) and (4))

The Controller gives general written authorisation for the sub-processors listed for the EU region at `/trust/subprocessors`. The Processor will give at least `[30]` days' notice of any intended addition or replacement through the product and by email to subscribed administrators. The Controller may object on reasonable data protection grounds within the notice period; `[remedy on objection to be agreed by legal]`. The Processor imposes the same data protection obligations on each sub-processor by contract and remains liable for them.

## 6. Data location and transfers

Personal data for EU workspaces is stored and processed in AWS eu-central-1 (Frankfurt), including logs, caches, queues and email; backup copies are kept only in AWS eu-west-1 (Ireland). It is not transferred outside the EU by the Processor. `[Legal to confirm whether remote support access by sub-processor personnel outside the EU/EEA is a transfer under Chapter V and, if so, the safeguard (e.g. the Commission's standard contractual clauses).]`

## 7. Data subject rights (Art. 28(3)(e))

The service provides tools for the Controller to respond to requests: per-person access exports (JSON and PDF), correction through effective-dated changes, and erasure that honours legal holds and statutory retention. The product calculates deadlines under GDPR Article 12(3) from the jurisdiction packs.

## 8. Assistance with Articles 32 to 36 (Art. 28(3)(f))

The Processor provides the DPIA template (docs/legal/dpia-template.md), security documentation and reasonable assistance with prior consultation.

## 9. Personal data breaches (Art. 33(2))

The Processor will notify the Controller **without undue delay** after becoming aware of a personal data breach affecting the Controller's data, and in any event within `[48]` hours (contractual target, for legal review), with the information then available. The Processor keeps a breach register and records the notification. The Controller remains responsible for notifying the competent supervisory authority and data subjects.

## 10. Deletion or return at the end (Art. 28(3)(g))

The Controller can export all of its data at any time. On account closure the workspace enters a `[30]`-day grace period during which closure can be cancelled and exports remain available. After it, the Processor deletes the data from the database, files, caches and search indexes and issues a deletion certificate. Backup copies expire automatically within the backup retention window stated on the certificate (`[35]` days in production) and are never restored except for disaster recovery.

## 11. Audits and information (Art. 28(3)(h))

The Processor makes available the information necessary to demonstrate compliance, including docs/COMPLIANCE.md and its evidence, and allows audits by the Controller or an auditor it mandates `[frequency, notice and cost terms to be agreed]`.

## 12. Liability, governing law

`[To be completed by legal: liability caps, order of precedence, governing law of an EU member state `[to be chosen]`.]`
