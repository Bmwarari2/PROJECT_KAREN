# Sub-processors

Thapsus-HR is the processor and each customer is the controller. Personal data goes to a third party only if that party is listed here, with its purpose and location for each home region. Every entry is added **before** the integration is written. Customers are notified of changes through the in-app sub-processor page (`/trust#subprocessors`) at least 30 days before a new sub-processor starts processing their data. That notice period is a draft pending legal review; see HUMAN_TODO.md.

## Core infrastructure (all customers)

| Sub-processor | Purpose | UK tenants | EU tenants | US tenants | Personal data |
| --- | --- | --- | --- | --- | --- |
| Amazon Web Services EMEA SARL / Amazon Web Services, Inc. | Hosting, database, file storage, cache, queues, logs, backups, key management (KMS) | eu-west-2 (London) only; backups stay in London across availability zones | eu-central-1 (Frankfurt); backup copies in eu-west-1 (Ireland) | us-east-2 (Ohio); backup copies in us-west-1 (N. California) | All customer data, encrypted at rest and in transit |
| Amazon Web Services (Amazon SES) | Transactional email: sign-in links, notifications, workspace lists | SES in eu-west-2 | SES in eu-central-1 | SES in us-east-2 | Recipient email address and message content |

The global layer runs in AWS eu-west-2. It holds the tenant directory (tenant id, workspace name, home region, status, plan, verified domains) and billing references. It holds **no employee personal data**.

## Billing (company-level data only)

| Sub-processor | Purpose | Location | Personal data |
| --- | --- | --- | --- |
| Stripe Payments Europe Ltd / Stripe, Inc. | Subscription billing and tax calculation (Stripe Billing, Stripe Tax) | Stripe's own infrastructure (EU / US) | Billing contact name, billing email and company address of the customer's account owner. **No employee data is ever sent.** This is enforced by the billing module tests. |

## Optional features (only when the customer turns them on)

| Sub-processor | Purpose | UK tenants | EU tenants | US tenants | Personal data |
| --- | --- | --- | --- | --- | --- |
| Amazon Web Services EMEA SARL / Amazon Web Services, Inc. (Amazon Bedrock, model by Anthropic: Claude Opus 5.5) | "Ask HR" assistant: answers employees' questions from the customer's own policy documents (off by default; needs the Thapsus entitlement and the customer's opt-in, ADR-0112) | **eu-west-2 (London) only**: In-Region inference on `bedrock-runtime`, never a cross-Region inference profile | **Not available.** No Claude model runs In-Region in eu-central-1 (checked 2026-10-18), so Ask HR cannot be turned on and nothing is sent | **Not available.** No Claude model runs In-Region in us-east-2 on `bedrock-runtime` (checked 2026-10-18), so Ask HR cannot be turned on and nothing is sent | The question, with emails, phone numbers, national identifiers and the names and employee numbers of people in the directory removed, plus up to 5 excerpts of the customer's designated policy documents, scrubbed the same way. **Never** sensitive (vault) data, HR records, personal documents or other employees' data. Thapsus keeps no question or answer text (only a hash, the length, the outcome and the cited document ids). |

Availability per region is recorded with its AWS documentation sources in ADR-0110 and in `packages/core/src/ai-models.ts`. It is re-checked before any region is enabled (HUMAN_TODO 7.5). Model invocation logging in Bedrock stays off; if it is ever turned on, it must log only to the cell's own region.

## Customer-directed integrations

These are services the customer contracts with directly and connects to Thapsus-HR. Data flows to them on the customer's instruction, through per-customer admin consent. They are the customer's processors, not ours. They are listed here for transparency.

| Integration | Purpose | Data sent |
| --- | --- | --- |
| Microsoft 365 (Microsoft Graph) | Joiner and leaver account automation | Name, work email, job title, department, manager, start and leave dates |
| Google Workspace (Admin SDK) | Joiner and leaver account automation | As above |
| Xero Payroll (UK) | Payroll handoff | Pay-period export fields chosen in the connector mapping |
| Customer SFTP or S3 | Scheduled data exports and payroll files | Fields chosen by the customer |
| Customer SIEM (HTTPS or S3) | Audit log streaming | Audit events (sensitive values redacted) |
| Customer webhook endpoints | Event notifications to the customer's systems | Event type, ids and names of changed fields (no field values) |
| Customer API clients (API keys, OAuth clients) | The customer's own integrations reading or writing through the public API | Whatever the client's role and scopes allow |

### Destinations the controller configures (webhooks, audit streaming, API clients)

Webhook endpoints, SIEM streams (HTTPS endpoints and S3 buckets) and API clients are chosen and configured by the customer, who is the **controller**. They are not Thapsus sub-processors. Thapsus sends data only to destinations an admin of that workspace has configured, and stops as soon as the destination is disabled, deleted or revoked, or the feature is turned off.

- **Origin:** every outbound call starts in the workspace's **home region**: London for UK workspaces, Frankfurt for EU and Ohio for US. Thapsus never relays it through another region.
- **S3 audit streams:** these can only target a bucket in the home region. The residency-guarded AWS client factory refuses any other region, and this is tested for every region pair.
- **What is sent:** webhook payloads carry identifiers and the names of changed fields only. Audit streams omit the values of sensitive changes.
- **Safety:** destinations must be public `https://` addresses. Private, internal and cloud-metadata addresses are refused (SSRF protection).
- **Sandboxes:** a sandbox copies no destinations. It gets no webhooks, audit streams or API keys from production.
