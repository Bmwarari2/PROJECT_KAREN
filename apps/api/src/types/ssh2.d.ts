/**
 * Minimal typings for the parts of ssh2 (MIT) used by the SFTP payroll transport and its test server.
 * Written locally instead of @types/ssh2, which pulls in @types/node@18 next to this repo's Node 24 types.
 */
declare module 'ssh2' {
  import type { EventEmitter } from 'node:events';

  export interface ConnectConfig {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    readyTimeout?: number;
    hostVerifier?: (key: Buffer) => boolean;
  }

  export interface Stats {
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export interface SFTPWrapper extends EventEmitter {
    writeFile(path: string, data: Buffer, cb: (err?: Error | null) => void): void;
    rename(src: string, dest: string, cb: (err?: Error | null) => void): void;
    stat(path: string, cb: (err: Error | null | undefined, stats: Stats) => void): void;
    unlink(path: string, cb: (err?: Error | null) => void): void;
    end(): void;
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): this;
    sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void;
    end(): this;
  }

  /** Server side (used only by the in-process test SFTP server); connections are untyped event emitters. */
  export class Server extends EventEmitter {
    constructor(config: { hostKeys: Array<string | Buffer> }, listener?: (client: EventEmitter) => void);
    listen(port: number, host: string, cb?: () => void): this;
    address(): { port: number; address: string };
    close(cb?: () => void): this;
  }

  export interface ParsedKey {
    type: string;
    getPublicSSH(): Buffer;
  }

  export const utils: {
    generateKeyPairSync(
      type: 'ed25519' | 'ecdsa' | 'rsa',
      opts?: { bits?: number },
    ): { private: string; public: string };
    parseKey(data: string | Buffer, passphrase?: string): ParsedKey | ParsedKey[] | Error;
    sftp: {
      OPEN_MODE: Record<string, number>;
      STATUS_CODE: Record<string, number>;
      flagsToString(flags: number): string | null;
    };
  };

  const ssh2: { Client: typeof Client; Server: typeof Server; utils: typeof utils };
  export default ssh2;
}
