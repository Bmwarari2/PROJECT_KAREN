# Sub-processors

Thapsus-HR is the processor and each customer is the controller. Personal data goes to a third party only if that party is listed here, with its purpose and location for each home region. Every entry is added **before** the integration is written. Customers are notified of changes through the in-app sub-processor page (`/trust#subprocessors`) at least 30 days before a new sub-processor starts processing their data. That notice period is a draft pending legal review; see HUMAN_TODO.md.

## Core infrastructure (all customers)

| Sub-processor | Purpose | UK tenants | EU tenants | US tenants | Personal data |
| --- | --- | --- | --- | --- | --- |
| Amazon Web Services EMEA SARL / Amazon Web Services, Inc. | Hosting, database, file storage, cache, queues, logs, backups, key management (KMS) | eu-west-2 (London) only; backups stay in London across availability zones | eu-central-1 (Frankfurt); backup copies in eu-west-1 (Ireland) | us-east-2 (Ohio); backup copies in us-west-1 (N. California) | All customer data, encrypted at rest and in transit |
| Amazon Web Services (Amazon SES) | Transactional email: sign-in links, notifications, workspace lists | SES in eu-west-2 | SES in eu-central-1 | SES in us-east-2 | Recipient email address and message content |

The global layer runs in AWS eu-west-2. It holds the tenant directory (tenant id, workspace slug, home region, status, plan reference, verified domains). Billing state, billing contacts and invoices live in each tenant's home cell, not in the global layer (ADR-0103). It holds **no employee personal data**.

## Billing (company-level data only)

| Sub-processor | Purpose | Location | Personal data |
| --- | --- | --- | --- |
| Stripe Payments Europe Ltd / Stripe, Inc. | Subscription billing, invoicing and tax calculation (Stripe Billing, Stripe Tax), test mode until the product owner approves live mode | Stripe's own infrastructure (EU / US). One Stripe account per home region (UK, EU, US), called only from that region's cell, so webhooks for a UK customer are delivered only to the UK cell (ADR-0103) | The primary billing contact's name and email, the company's legal name, company billing address and company tax id, the purchase order number, the plan, term, currency, prices and an aggregate employee **count** used for banding, plus opaque Thapsus ids (tenant id, billing account id) as metadata. Card details are entered on Stripe-hosted pages and never touch Thapsus-HR. **No employee data is ever sent** (no names, emails, employee numbers or any employee record field). Enforced by `apps/api/test/billing.int.test.ts` (every payload sent to the billing provider is inspected) and `apps/api/test/billing-stripe.test.ts`. |

## Optional features (only when the customer turns them on)

| Sub-processor | Purpose | UK tenants | EU tenants | US tenants | Personal data |
| --- | --- | --- | --- | --- | --- |
| Amazon Web Services (Amazon Bedrock, Anthropic Claude models) | "Ask HR" assistant (off by default) | eu-west-2 where the model is available, otherwise disabled. To be verified at enablement (Phase 11). | eu-central-1 | us-east-2 | The question asked and excerpts of the company's own policy documents. Never sensitive data or other employees' data. |

## Customer-directed integrations

These are services the customer contracts with directly and connects to Thapsus-HR. Data flows to them on the customer's instruction, through per-customer admin consent. They are the customer's processors, not ours. They are listed here for transparency.

| Integration | Purpose | Data sent |
| --- | --- | --- |
| Microsoft 365 (Microsoft Graph) | Joiner and leaver account automation | Name, work email, job title, department, manager, start and leave dates |
| Google Workspace (Admin SDK) | Joiner and leaver account automation | As above |
| Xero Payroll (UK) | Payroll handoff | Pay-period export fields chosen in the connector mapping |
| Customer SFTP or S3 | Scheduled data exports and payroll files | Fields chosen by the customer |
| Customer SIEM (HTTPS or S3) | Audit log streaming | Audit events (sensitive values redacted) |
