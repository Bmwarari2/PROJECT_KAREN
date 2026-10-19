# Data processing addendum — United States (service provider terms, including the CCPA/CPRA)

> **DRAFT — for legal review.** Version 2026-10-18. Drafted by the engineering team from Cal. Civ. Code §1798.140(ag) (service provider contract terms) as published by the California Privacy Protection Agency (https://cppa.ca.gov/regulations/pdf/ccpa_statute.pdf) and from the product's actual controls. Not legal advice. It must be reviewed by qualified US privacy counsel before it is offered to customers, including for state laws other than California (docs/HUMAN_TODO.md 3.3). Customers accept the current version in the product (Privacy → Legal); acceptance is recorded with the version, the user and the time, and a new version must be accepted again.

This addendum forms part of the terms between the customer (**Business**) and Thapsus `[legal entity]` (**Service Provider**) for the Thapsus-HR service, for workspaces whose home region is the **United States (AWS us-east-2, Ohio)**.

## 1. Business purpose

The Service Provider processes personal information of the Business's job applicants, employees, owners, directors, officers and contractors, and their emergency contacts, solely to provide the Thapsus-HR service described in the order and this addendum (the **business purpose**): HR records, time off, rotas and time tracking, documents, payroll handoff, IT automation, reports and self-service.

## 2. Restrictions (Civ. Code §1798.140(ag)(1))

The Service Provider shall not:

- (A) sell or share the personal information;
- (B) retain, use or disclose it for any purpose other than the business purpose specified here, including for a commercial purpose other than that business purpose, except as the law permits;
- (C) retain, use or disclose it outside the direct business relationship with the Business;
- (D) combine it with personal information received from or on behalf of anyone else, or collected from its own interaction with the consumer, except as permitted by regulations.

The Service Provider certifies that it understands and will comply with these restrictions. `[Legal to add the remaining terms required by the CCPA regulations (11 CCR §7051), which could not be verified automatically.]`

## 3. Compliance monitoring

The Business may take reasonable steps to check compliance, including reviewing docs/COMPLIANCE.md evidence and `[an annual assessment or audit]`. The Service Provider will tell the Business if it can no longer meet its obligations `[legal to confirm wording]`.

## 4. Sub-processors (Civ. Code §1798.140(ag)(2))

The Service Provider will notify the Business of each person it engages to help process personal information, through the public list at `/trust/subprocessors` and by email to subscribed administrators at least `[30]` days before the change, and will bind each one by written contract to the same requirements.

## 5. Consumer requests

The service provides tools for the Business to respond to requests to know, correct and delete within the statutory period: the product calculates the 45-day deadline and the one-time 45-day extension under Civ. Code §1798.130(a)(2) for California residents. The Service Provider will assist with requests it receives directly by passing them to the Business.

## 6. Security and breaches

The Service Provider maintains the security measures in docs/SECURITY.md, including field-level encryption of sensitive personal information with a US-region KMS key. It will notify the Business without undue delay, and in any event within `[48]` hours (contractual target, for legal review), after discovering a security breach of the Business's data, so that the Business can meet state notification laws. The product records the state notification rules in its jurisdiction packs where they were verified.

## 7. Data location

Personal information is stored and processed in AWS us-east-2 (Ohio); backup copies are kept only in AWS us-west-1 (N. California).

## 8. Deletion at the end

As in the UK and EU agreements: export at any time; closure with a `[30]`-day grace period; verified deletion with a certificate; backups expire within the stated window (`[35]` days in production).

## 9. Other state laws

`[Legal to confirm whether any other state privacy laws apply to employee data and add terms as needed.]` California's employee-data exemption became inoperative on 1 January 2023 (Civ. Code §1798.145(m)(4)).
