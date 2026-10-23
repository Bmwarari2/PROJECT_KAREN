import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Context } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/sdk-trace-base';
import { isPersonalKey, REDACTED, scrubString } from './scrub';

/** Removes personal data from span attributes before export. */
export function scrubSpanAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const leaf = k.split('.').pop() ?? k;
    if (isPersonalKey(leaf) || /http\.request\.body|db\.statement\.params|url\.query/.test(k))
      out[k] = REDACTED;
    else out[k] = typeof v === 'string' ? scrubString(v) : v;
  }
  return out;
}

class ScrubbingProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}
  onStart(span: Span, ctx: Context) {
    this.inner.onStart(span, ctx);
  }
  onEnd(span: ReadableSpan) {
    const mutable = span as unknown as { attributes: Record<string, unknown> };
    mutable.attributes = scrubSpanAttributes(span.attributes);
    this.inner.onEnd(span);
  }
  forceFlush() {
    return this.inner.forceFlush();
  }
  shutdown() {
    return this.inner.shutdown();
  }
}

export function startTracing(serviceName: string, exporter?: SpanExporter) {
  if (process.env.OTEL_SDK_DISABLED === 'true') return undefined;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': serviceName,
      'cloud.region': process.env.AWS_REGION ?? 'local',
    }),
    spanProcessors: [new ScrubbingProcessor(new BatchSpanProcessor(exporter ?? new OTLPTraceExporter()))],
  });
  sdk.start();
  return sdk;
}
