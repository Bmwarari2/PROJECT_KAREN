import type { FastifyInstance } from 'fastify';
import '../jobs/core';
import { employeeRoutes } from './employees/routes';
import { orgRoutes } from './org/routes';
import { documentRoutes } from './documents/routes';
import { workflowRoutes } from './workflows/routes';
import { approvalRoutes } from './approvals/routes';
import { automationRoutes } from './automation/routes';
import { importRoutes } from './imports/routes';
import { rulesRoutes } from './rules/routes';
import { backofficeAuthRoutes } from './backoffice/auth';
import { leaveRoutes } from './leave/routes';
import { timeRoutes } from './time/routes';
import { payrollRoutes } from './payroll/routes';
import { payslipRoutes } from './payslips/routes';
import { itRoutes } from './it/routes';
import { assetRoutes } from './assets/routes';
import { complianceRoutes } from './compliance/routes';
import { reportRoutes } from './reports/routes';
import { exportRoutes } from './exports/routes';

/** Feature modules registered per phase. Importing a module also registers its jobs and subscribers. */
export async function registerModules(app: FastifyInstance) {
  await app.register(employeeRoutes);
  await app.register(orgRoutes);
  await app.register(documentRoutes);
  await app.register(workflowRoutes);
  await app.register(approvalRoutes);
  await app.register(automationRoutes);
  await app.register(importRoutes);
  await app.register(rulesRoutes);
  await app.register(backofficeAuthRoutes);
  await app.register(leaveRoutes);
  await app.register(timeRoutes);
  // Phase 6: payroll handoff, payslips, joiner/leaver IT automation and the asset register
  await app.register(payrollRoutes);
  await app.register(payslipRoutes);
  await app.register(itRoutes);
  await app.register(assetRoutes);
  // Phase 5: compliance centre
  await app.register(complianceRoutes);
  // Phase 7: reports, analytics, data export and employee self-service
  await app.register(reportRoutes);
  await app.register(exportRoutes);
}
