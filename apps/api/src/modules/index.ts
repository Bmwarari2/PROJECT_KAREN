import type { FastifyInstance } from 'fastify';
import '../jobs/core';
import { employeeRoutes } from './employees/routes';
import { orgRoutes } from './org/routes';
import { documentRoutes } from './documents/routes';
import { attachmentRoutes } from './documents/attachments';
import { countersignRoutes } from './documents/countersign';
import { workflowRoutes } from './workflows/routes';
import { approvalRoutes } from './approvals/routes';
import { automationRoutes } from './automation/routes';
import { importRoutes } from './imports/routes';
import { exportRoutes } from './exports/routes';
import { onboardingRoutes } from './onboarding/routes';
import { rulesRoutes } from './rules/routes';
import { backofficeAuthRoutes } from './backoffice/auth';
import { elevationRoutes } from './backoffice/elevations';
import { leaveRoutes } from './leave/routes';
import { timeRoutes } from './time/routes';
import { complianceRoutes } from './compliance/routes';
import { payrollRoutes } from './payroll/routes';
import { payslipRoutes } from './payslips/routes';
import { itRoutes } from './it/routes';
import { assetRoutes } from './assets/routes';
import { reportRoutes } from './reports/routes';
import { dataExportRoutes } from './data-export/routes';
import { essRoutes } from './me/ess-routes';
import { privacyRoutes } from './privacy/routes';
import { privacyBackofficeRoutes } from './privacy/backoffice';
import { billingRoutes } from './billing/routes';
import { supportTicketRoutes } from './support/tickets';
import { statusRoutes } from './status/routes';
import { backofficeRoutes } from './backoffice/routes';
import { backofficeMetricsRoutes } from './backoffice/metrics';
import { backofficePerformanceRoutes } from './backoffice/performance';
import { securityRoutes } from './security/routes';
import { securityCentreRoutes } from './security/centre';
import './security/alerts';
import { platformRoutes } from './platform';
import { aiRoutes } from './ai/routes';
import { roleRoutes } from './authz/routes';
import { hrRequestRoutes } from './workflows/hr-requests';

/** Feature modules registered per phase. Importing a module also registers its jobs and subscribers. */
export async function registerModules(app: FastifyInstance) {
  await app.register(employeeRoutes);
  await app.register(orgRoutes);
  await app.register(documentRoutes);
  // documents HR attaches to a person, and the in-app viewer (ADR-0165, ADR-0168)
  await app.register(attachmentRoutes);
  await app.register(countersignRoutes);
  await app.register(workflowRoutes);
  await app.register(hrRequestRoutes);
  await app.register(approvalRoutes);
  await app.register(automationRoutes);
  await app.register(importRoutes);
  await app.register(exportRoutes);
  await app.register(onboardingRoutes);
  await app.register(rulesRoutes);
  await app.register(backofficeAuthRoutes);
  await app.register(elevationRoutes);
  await app.register(leaveRoutes);
  await app.register(timeRoutes);
  await app.register(complianceRoutes);
  // Phase 6: payroll handoff, payslips, joiner/leaver IT automation and the asset register
  await app.register(payrollRoutes);
  await app.register(payslipRoutes);
  await app.register(itRoutes);
  await app.register(assetRoutes);
  // Phase 7: reports, analytics, data export and employee self-service
  await app.register(reportRoutes);
  await app.register(dataExportRoutes);
  await app.register(essRoutes);
  // Phase 8: privacy operations
  await app.register(privacyRoutes);
  await app.register(privacyBackofficeRoutes);
  // Phase 9: enterprise platform (API clients, webhooks, SCIM, sandboxes)
  await app.register(platformRoutes);
  // Phase 10: support, status page, back office, pricing and billing
  await app.register(billingRoutes);
  await app.register(supportTicketRoutes);
  await app.register(statusRoutes);
  await app.register(backofficeRoutes);
  // Founder's console: business figures, platform performance and security monitoring (ADR-0175 to ADR-0179)
  await app.register(backofficeMetricsRoutes);
  await app.register(backofficePerformanceRoutes);
  await app.register(securityRoutes);
  await app.register(securityCentreRoutes);
  // Phase 11: Ask HR assistant
  await app.register(aiRoutes);
  // Role and access management
  await app.register(roleRoutes);
}
