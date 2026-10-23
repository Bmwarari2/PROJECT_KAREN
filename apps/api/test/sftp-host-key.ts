import ssh2 from 'ssh2';
import { hostKeyFingerprint } from '../src/modules/payroll/sftp';

/**
 * A fresh ed25519 host key for an in-process SFTP server, with its pinned fingerprint. ssh2 cannot
 * parse about 1 in 500 of the keys its own generator makes ("Malformed OpenSSH private key"), so a
 * key that does not parse is replaced.
 */
export function sftpHostKey(): { privateKey: string; fingerprint: string } {
  for (;;) {
    const key = ssh2.utils.generateKeyPairSync('ed25519');
    const parsed = ssh2.utils.parseKey(key.private);
    if (parsed instanceof Error || Array.isArray(parsed)) continue;
    return {
      privateKey: key.private,
      fingerprint: hostKeyFingerprint((parsed as { getPublicSSH(): Buffer }).getPublicSSH()),
    };
  }
}
