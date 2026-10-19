/**
 * Content checks for uploaded files (ASVS V5.2.2): the bytes must match the declared type, whatever
 * name or Content-Type the client sent. Text types must contain no NUL bytes in their first 4 KB.
 */
export function matchesMagic(contentType: string, b: Buffer): boolean {
  const starts = (sig: number[]) => sig.every((v, i) => b[i] === v);
  switch (contentType) {
    case 'application/pdf':
      return starts([0x25, 0x50, 0x44, 0x46]);
    case 'image/png':
      return starts([0x89, 0x50, 0x4e, 0x47]);
    case 'image/jpeg':
      return starts([0xff, 0xd8, 0xff]);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return starts([0x50, 0x4b, 0x03, 0x04]);
    case 'text/csv':
    case 'text/plain':
    case 'text/markdown':
      return !b.subarray(0, 4096).includes(0);
    default:
      return false;
  }
}
