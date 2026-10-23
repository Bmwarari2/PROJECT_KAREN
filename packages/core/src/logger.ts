import pino, { type Logger, type LoggerOptions } from 'pino';
import { scrub, scrubString } from './scrub';

export type { Logger };

/** Cloud Logging severities for the pino levels (LOG_FORMAT=gcp, ADR-0156). */
const GCP_SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/**
 * Shared structured logger. Every object and message passes through the personal-data scrubber.
 * Request bodies are never logged: the serializers only keep method, route and status.
 * `format` (default: LOG_FORMAT, else `json`) set to `gcp` adds Cloud Logging's `severity` next to the
 * numeric `level` on every line.
 */
export function createLogger(
  opts: {
    name: string;
    level?: string;
    format?: string;
    destination?: pino.DestinationStream;
  } & LoggerOptions,
) {
  const { destination, format: formatOpt, ...rest } = opts;
  const format = formatOpt ?? process.env.LOG_FORMAT ?? 'json';
  if (format !== 'json' && format !== 'gcp') throw new Error('LOG_FORMAT must be json or gcp');
  const options: LoggerOptions = {
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: opts.name, region: process.env.CELL_REGION },
    messageKey: 'msg',
    formatters: {
      log: (obj) => scrub(obj),
      ...(format === 'gcp'
        ? { level: (label: string, level: number) => ({ severity: GCP_SEVERITY[label] ?? 'DEFAULT', level }) }
        : {}),
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? scrubString(a) : a)) as Parameters<
          typeof method
        >;
        method.apply(this, scrubbed);
      },
    },
    serializers: {
      req: (req: { method?: string; routeOptions?: { url?: string }; id?: string }) => ({
        method: req.method,
        route: req.routeOptions?.url,
        id: req.id,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: (err: Error) => ({
        type: err.name,
        message: scrubString(err.message),
        stack: scrubString(err.stack ?? ''),
      }),
    },
    ...rest,
  };
  return destination ? pino(options, destination) : pino(options);
}
