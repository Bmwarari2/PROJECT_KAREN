/**
 * Malware-scan hook for uploads (docs/SECURITY.md T14, security plan P1, HUMAN_TODO 1.7). Every upload that goes
 * through it is scanned before it is stored. No scanner is configured yet: the default verdict is `not_scanned`,
 * which is recorded on the document so a later scanner can sweep what was stored before it existed. A scanner
 * that says `infected` makes the upload fail and nothing is stored.
 */
export type ScanVerdict = 'clean' | 'infected' | 'not_scanned';

export interface UploadScanner {
  scan(file: { bytes: Buffer; contentType: string; tenantId: string }): Promise<ScanVerdict>;
}

const notScanned: UploadScanner = { scan: async () => 'not_scanned' };
let current: UploadScanner = notScanned;

/** Installs a scanner (tests, or a future scanning service); `undefined` restores the default. */
export function setUploadScanner(scanner: UploadScanner | undefined): void {
  current = scanner ?? notScanned;
}

export function scanUpload(file: {
  bytes: Buffer;
  contentType: string;
  tenantId: string;
}): Promise<ScanVerdict> {
  return current.scan(file);
}
