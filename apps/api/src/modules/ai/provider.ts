import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { HomeRegion } from '@thapsus/core';
import { inRegionModel, isCrossRegionProfileId, type InRegionModel } from '@thapsus/core/ai-models';
import { createAwsClientFactory, type AwsClientOptions } from '@thapsus/core/aws';

/**
 * The model behind "Ask HR". Routes depend only on this interface (injected through `deps.ai`), so
 * tests capture exactly what would be sent and never call a real model.
 */
export interface AiCompletionRequest {
  /** Frozen system prompt (cacheable prefix). */
  system: string;
  /** The single user turn: policy excerpts plus the scrubbed question. */
  user: string;
  maxTokens: number;
}

export interface AiCompletion {
  text: string;
  stopReason: string;
}

export interface AiProvider {
  /** Human-readable model name shown with answers, e.g. "Claude Opus 5.5". */
  readonly modelName: string;
  readonly modelId: string;
  complete(req: AiCompletionRequest, opts?: { signal?: AbortSignal }): Promise<AiCompletion>;
}

export class AiUnavailableError extends Error {
  constructor(readonly cell: HomeRegion) {
    super(`No in-region model for the ${cell} cell`);
    this.name = 'AiUnavailableError';
  }
}

/**
 * Claude on Amazon Bedrock, InvokeModel on bedrock-runtime in the cell's home region only.
 * The client comes from the residency-guarded factory (which refuses any other region), and the
 * model id must be a bare foundation-model id: cross-Region inference profiles are refused because
 * they route requests outside the home region (ADR-0110).
 */
export class BedrockClaudeProvider implements AiProvider {
  readonly modelName: string;
  readonly modelId: string;
  readonly client: BedrockRuntimeClient;

  constructor(
    readonly cell: HomeRegion,
    opts: { model?: InRegionModel; client?: AwsClientOptions } = {},
  ) {
    const model = opts.model ?? inRegionModel(cell);
    if (!model) throw new AiUnavailableError(cell);
    if (isCrossRegionProfileId(model.modelId)) throw new Error(`Refusing cross-Region inference profile ${model.modelId}`);
    this.modelId = model.modelId;
    this.modelName = model.modelName;
    this.client = createAwsClientFactory({ cell })(
      BedrockRuntimeClient,
      'bedrock-runtime',
      { region: model.awsRegion, ...opts.client },
    );
  }

  async complete(req: AiCompletionRequest, opts: { signal?: AbortSignal } = {}): Promise<AiCompletion> {
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: req.maxTokens,
      // Short Q&A over supplied excerpts: low effort is enough (thinking stays adaptive on this model).
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: req.user }] }],
    };
    const out = await this.client.send(
      new InvokeModelCommand({ modelId: this.modelId, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body) }),
      { abortSignal: opts.signal },
    );
    const parsed = JSON.parse(new TextDecoder().decode(out.body)) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
    const text = (parsed.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return { text, stopReason: parsed.stop_reason ?? 'unknown' };
  }
}

/**
 * Deterministic stand-in for dev, tests and e2e (AI_PROVIDER=fake). It quotes the first sentence of
 * the first excerpt with a citation, and declines when there are no excerpts. Never allowed in prod.
 */
export class FakeAiProvider implements AiProvider {
  readonly modelName = 'Test model';
  readonly modelId = 'fake';
  async complete(req: AiCompletionRequest): Promise<AiCompletion> {
    const m = /<excerpt n="1"[^>]*>([\s\S]*?)<\/excerpt>/.exec(req.user);
    if (!m) return { text: 'NO_ANSWER', stopReason: 'end_turn' };
    const sentence = m[1]!.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0]!.slice(0, 300);
    return { text: `According to your company policy: ${sentence} [1]`, stopReason: 'end_turn' };
  }
}

/** Picks the provider for this cell: Bedrock in AWS, the fake locally (opt-in), or none when unavailable. */
export function aiProviderFromEnv(cell: HomeRegion, env: NodeJS.ProcessEnv = process.env): AiProvider | undefined {
  const choice = env.AI_PROVIDER ?? (env.APP_ENV === 'prod' || env.APP_ENV === 'staging' ? 'bedrock' : 'fake');
  if (choice === 'fake') {
    if (env.APP_ENV === 'prod') throw new Error('The fake AI provider may never run in production');
    return new FakeAiProvider();
  }
  if (choice === 'none' || !inRegionModel(cell)) return undefined;
  return new BedrockClaudeProvider(cell);
}
