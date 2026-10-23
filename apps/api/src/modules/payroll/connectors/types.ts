import type { HomeRegion } from '@thapsus/core';
import type { FieldMapping } from '../mapping';
import type { PayrollInputs } from '../inputs';

export const CONNECTOR_KINDS = [
  'csv',
  'excel',
  'xero_uk',
  'adp',
  'workday',
  'ukg',
  'gusto',
  'datev',
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export type DeliveryMethod = 'download' | 'sftp' | 'api';

export interface SftpDestination {
  host: string;
  port: number;
  username: string;
  directory: string;
  /** OpenSSH-style host key fingerprint, e.g. "SHA256:base64…". Required: the host key is always pinned. */
  hostKeySha256: string;
}
export interface DeliveryConfig {
  method: DeliveryMethod;
  sftp?: SftpDestination;
}

export interface ConnectorRow {
  id: string;
  name: string;
  kind: ConnectorKind;
  entity_id: string | null;
  mapping: FieldMapping;
  delivery: DeliveryConfig;
  settings: Record<string, unknown>;
  enabled: boolean;
}

export interface RenderedExport {
  body: Buffer;
  fileName: string;
  contentType: string;
  counts: Record<string, number>;
}

export interface ItemResult {
  key: string;
  status: 'succeeded' | 'failed' | 'skipped';
  remoteId?: string;
  reason?: string;
}

export interface PushContext {
  fetch: typeof fetch;
  credentials: Record<string, string> | undefined;
  /** Persists rotated secrets (e.g. a new OAuth refresh token) sealed, in the caller's transaction. */
  saveCredentials(values: Record<string, string>): Promise<void>;
  /** Platform OAuth app credentials (Secrets Manager), when the customer has not brought their own. */
  platformApp?: { clientId: string; clientSecret: string };
  /** Prefix for provider idempotency keys (the export id), so re-deliveries never duplicate records. */
  idempotencyPrefix: string;
  /** Results of an earlier attempt of the same delivery; succeeded items are not sent again. */
  previous: Record<string, ItemResult>;
}

export interface PushResult {
  status: 'succeeded' | 'partial' | 'failed';
  destination: string;
  items: ItemResult[];
}

/** A payroll connector: renders the canonical inputs into the target's format, and optionally pushes them. */
export interface PayrollConnector {
  kind: ConnectorKind;
  status: 'available' | 'stub';
  formats: Array<'csv' | 'xlsx' | 'json'>;
  deliveries: DeliveryMethod[];
  /** Home regions where the connector may be enabled (customer-directed integration listed per region). */
  regions: HomeRegion[];
  /** Anchor in docs/integrations.md. */
  docs: string;
  render(inputs: PayrollInputs, connector: ConnectorRow): Promise<RenderedExport>;
  push?(ctx: PushContext, rendered: RenderedExport, connector: ConnectorRow): Promise<PushResult>;
}

export class ConnectorNotImplementedError extends Error {
  constructor(
    readonly kind: ConnectorKind,
    readonly docs: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorNotImplementedError';
  }
}
