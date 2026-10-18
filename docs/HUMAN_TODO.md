# Human-only steps

Things only a person with the right accounts or authority can do. The build runs against mocks or test mode until each is done. Steps are exact and numbered; tick them off here.

## 1. AWS organisation and regions

- [x] 1.1 Relax SCP `p-muwhpaps` so the staging account can use eu-west-2, eu-central-1, us-east-2, eu-west-1 and us-west-1. (Done by the product owner on 2026-10-18.)
- [ ] 1.2 **CloudFront in front of the marketing site (optional).** CloudFront needs its ACM certificate in **us-east-1**, which the SCP reserves for global services. Deploying stacks there is not allowed (ADR-0001), so to put the public marketing site behind CloudFront:
  1. Sign in to the management account (or ask whoever owns SCP `p-muwhpaps`) and decide whether to allow `acm:RequestCertificate`, `acm:DescribeCertificate` and `acm:DeleteCertificate` in us-east-1 for the staging and production accounts.
  2. If allowed: in the AWS console, region **N. Virginia (us-east-1)**, open ACM → Request certificate → public → `www.<domain>` and `<domain>` → DNS validation → create the records in Route 53.
  3. Copy the certificate ARN into `infra/config/<env>.json` as `marketingCloudFrontCertArn` and redeploy the global stack. Until then the marketing site is served by the eu-west-2 regional ALB (no CDN). Authenticated app and API hosts never use a CDN in either case.
- [ ] 1.3 **CloudFront-scoped WAF.** Same constraint as 1.2: a WAF web ACL for CloudFront must be created in us-east-1. It is only needed if 1.2 is done. Regional ALBs already have regional WAF web ACLs.
