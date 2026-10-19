import { csvConnector, excelConnector } from './files';
import { stubConnectors } from './stubs';
import { xeroConnector } from './xero';
import type { ConnectorKind, PayrollConnector } from './types';

export * from './types';

/** Connector registry. Adding a connector here does not enable it: a customer creates and enables it. */
export const CONNECTORS: Record<ConnectorKind, PayrollConnector> = Object.fromEntries(
  [csvConnector, excelConnector, xeroConnector, ...stubConnectors].map((c) => [c.kind, c]),
) as Record<ConnectorKind, PayrollConnector>;
