import pino, { type Logger, type LoggerOptions } from 'pino';
import { scrub, scrubString } from './scrub';

export type { Logger };

/**
 * Shared structured logger. Every object and message passes through the personal-data scrubber.
 * Request bodies are never logged: the serializers only keep method, route and status.
 */
export function createLogger(
  opts: { name: string; level?: string; destination?: pino.DestinationStream } & LoggerOptions,
) {
  const { destination, ...rest } = opts;
  const options: LoggerOptions = {
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: opts.name, region: process.env.CELL_REGION },
    messageKey: 'msg',
    formatters: {
      log: (obj) => scrub(obj),
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
