import { mapInputs } from '../mapping';
import { sectionCounts } from '../inputs';
import { fileBaseName, renderCsvBundle, renderXlsx } from '../render';
import type { PayrollConnector } from './types';

const SHEETS: Record<string, string> = {
  hours: 'Hours',
  absences: 'Absences',
  sickPay: 'Sick pay',
  payChanges: 'Pay changes',
  starters: 'Starters',
  leavers: 'Leavers',
};

/**
 * Generic CSV: one CSV per enabled section (a single section gives a plain .csv, several give a .zip of
 * CSVs). Delivered by download or to the customer's SFTP host — the "SFTP connector" is this file format
 * over the SFTP transport.
 */
export const csvConnector: PayrollConnector = {
  kind: 'csv',
  status: 'available',
  formats: ['csv'],
  deliveries: ['download', 'sftp'],
  regions: ['uk', 'eu', 'us'],
  docs: 'docs/integrations.md#generic-csv-and-excel',
  async render(inputs, connector) {
    const tables = mapInputs(inputs, connector.mapping);
    const out = await renderCsvBundle(
      tables,
      connector.mapping,
      fileBaseName(connector.name, inputs.period.startDate, inputs.period.endDate),
      inputs.period.endDate,
    );
    return { ...out, counts: sectionCounts(inputs) };
  },
};

/** Generic Excel: one workbook, one sheet per enabled section, typed number cells. */
export const excelConnector: PayrollConnector = {
  kind: 'excel',
  status: 'available',
  formats: ['xlsx'],
  deliveries: ['download', 'sftp'],
  regions: ['uk', 'eu', 'us'],
  docs: 'docs/integrations.md#generic-csv-and-excel',
  async render(inputs, connector) {
    const tables = mapInputs(inputs, connector.mapping);
    const out = await renderXlsx(
      tables,
      fileBaseName(connector.name, inputs.period.startDate, inputs.period.endDate),
      inputs.period.endDate,
      SHEETS,
    );
    return { ...out, counts: sectionCounts(inputs) };
  },
};
