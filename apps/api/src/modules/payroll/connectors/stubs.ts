import { ConnectorNotImplementedError, type ConnectorKind, type PayrollConnector } from './types';

/**
 * Documented stubs. Each implements the connector interface so it can be listed, configured and planned
 * for, but rendering and pushing refuse with a clear message until the partner programme is joined (the
 * exact steps are in docs/HUMAN_TODO.md section 4) and the integration is listed in SUBPROCESSORS.md.
 * Until then customers use the generic CSV or Excel connector with a field mapping for that provider.
 */
const STUBS: Array<{
  kind: ConnectorKind;
  product: string;
  programme: string;
  regions: PayrollConnector['regions'];
}> = [
  {
    kind: 'adp',
    product: 'ADP (Workforce Now / iHCM)',
    programme: 'the ADP Marketplace partner programme',
    regions: ['uk', 'eu', 'us'],
  },
  {
    kind: 'workday',
    product: 'Workday Payroll',
    programme: 'the Workday Partner Network (or a customer-sponsored integration system user)',
    regions: ['uk', 'eu', 'us'],
  },
  {
    kind: 'ukg',
    product: 'UKG Pro / UKG Ready',
    programme: 'the UKG partner programme',
    regions: ['uk', 'eu', 'us'],
  },
  { kind: 'gusto', product: 'Gusto', programme: 'the Gusto Embedded partner programme', regions: ['us'] },
  {
    kind: 'datev',
    product: 'DATEV Lohn und Gehalt',
    programme: 'the DATEV Marktplatz partner programme',
    regions: ['eu'],
  },
];

export const stubConnectors: PayrollConnector[] = STUBS.map(({ kind, product, programme, regions }) => {
  const docs = `docs/integrations.md#${kind}`;
  const refuse = (): never => {
    throw new ConnectorNotImplementedError(
      kind,
      docs,
      `The ${product} connector is not available yet: it needs ${programme}. Use the generic CSV or Excel connector with a field mapping for ${product} meanwhile (${docs}).`,
    );
  };
  return {
    kind,
    status: 'stub',
    formats: [],
    deliveries: ['api'],
    regions,
    docs,
    render: async () => refuse(),
    push: async () => refuse(),
  };
});
