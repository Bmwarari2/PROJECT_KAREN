import type { RuleBook } from '@thapsus/rules';
import type { Tx } from '@thapsus/db';
import { ApiError } from '../../http/errors';
import { objectKey, type ObjectStore } from '../../lib/object-store';
import { buildPayrollInputs, canonicalJson, sha256Hex, type PayrollInputs, type PeriodRow } from './inputs';
import { CONNECTORS, ConnectorNotImplementedError, type ConnectorRow } from './connectors';

export const PERIOD_COLS =
  'id, name, entity_id, frequency, start_date, end_date, pay_date, status, snapshot_id, closed_at, created_at';

export async function loadPeriod(
  tx: Tx,
  id: string,
  lock = false,
): Promise<PeriodRow & { closed_at: string | null; created_at: string }> {
  const p = await tx.maybe<PeriodRow & { closed_at: string | null; created_at: string }>(
    `SELECT ${PERIOD_COLS} FROM app.pay_periods WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (!p) throw new ApiError('notFound');
  return p;
}

export async function loadConnector(
  tx: Tx,
  id: string,
): Promise<ConnectorRow & { created_at: string; updated_at: string }> {
  const c = await tx.maybe<ConnectorRow & { created_at: string; updated_at: string }>(
    'SELECT id, name, kind, entity_id, mapping, delivery, settings, enabled, created_at, updated_at FROM app.payroll_connectors WHERE id = $1',
    [id],
  );
  if (!c) throw new ApiError('notFound');
  return c;
}

/** Inputs for a period: the frozen snapshot once closed (integrity-checked), live data while open. */
export async function inputsFor(
  tx: Tx,
  book: RuleBook,
  period: PeriodRow,
): Promise<{ inputs: PayrollInputs; sha256: string; snapshotId: string | null }> {
  if (period.status === 'closed') {
    const s = await tx.one<{ id: string; inputs: PayrollInputs; sha256: string }>(
      'SELECT id, inputs, sha256 FROM app.pay_period_snapshots WHERE id = $1',
      [period.snapshot_id],
    );
    const actual = sha256Hex(canonicalJson(s.inputs));
    if (actual !== s.sha256) throw new ApiError('internal', 'Snapshot integrity check failed');
    return { inputs: s.inputs, sha256: s.sha256, snapshotId: s.id };
  }
  const inputs = await buildPayrollInputs(tx, book, period);
  return { inputs, sha256: sha256Hex(canonicalJson(inputs)), snapshotId: null };
}

/** Hash of everything about a connector that changes its output (not its name's casing alone, not credentials). */
export function connectorConfigHash(
  c: Pick<ConnectorRow, 'kind' | 'name' | 'mapping' | 'settings' | 'entity_id'>,
) {
  return sha256Hex(
    canonicalJson({
      kind: c.kind,
      name: c.name,
      mapping: c.mapping,
      settings: c.settings,
      entityId: c.entity_id,
    }),
  );
}

export interface ExportRow {
  id: string;
  period_id: string;
  connector_id: string;
  snapshot_id: string | null;
  file_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  inputs_sha256: string;
  config_sha256: string;
  counts: Record<string, number>;
  created_at: string;
}
export const mapExport = (e: ExportRow) => ({
  id: e.id,
  periodId: e.period_id,
  connectorId: e.connector_id,
  fileName: e.file_name,
  contentType: e.content_type,
  sizeBytes: e.size_bytes,
  sha256: e.sha256,
  inputsSha256: e.inputs_sha256,
  configSha256: e.config_sha256,
  reproducible: e.snapshot_id !== null,
  counts: e.counts,
  createdAt: e.created_at,
});

/** Renders and stores an export in the home-region object store. */
export async function createExport(
  tx: Tx,
  objects: ObjectStore,
  tenantId: string,
  book: RuleBook,
  period: PeriodRow,
  connector: ConnectorRow,
  actor: string | null,
): Promise<ExportRow> {
  const def = CONNECTORS[connector.kind];
  if (!connector.enabled) throw new ApiError('unprocessable', 'This connector is disabled');
  const { inputs, sha256: inputsSha, snapshotId } = await inputsFor(tx, book, period);
  let rendered;
  try {
    rendered = await def.render(inputs, connector);
  } catch (err) {
    if (err instanceof ConnectorNotImplementedError)
      throw new ApiError('notImplemented', err.message, { docs: err.docs });
    throw err;
  }
  const key = objectKey(tenantId, `payroll/exports/${period.id}`, '');
  await objects.put(key, rendered.body, rendered.contentType);
  return tx.one<ExportRow>(
    `INSERT INTO app.payroll_exports (tenant_id, period_id, connector_id, snapshot_id, file_key, file_name, content_type, size_bytes, sha256, inputs_sha256, config_sha256, counts, created_by)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      period.id,
      connector.id,
      snapshotId,
      key,
      rendered.fileName,
      rendered.contentType,
      rendered.body.length,
      sha256Hex(rendered.body),
      inputsSha,
      connectorConfigHash(connector),
      JSON.stringify(rendered.counts),
      actor,
    ],
  );
}
