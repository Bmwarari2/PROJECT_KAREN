import { REGIONS, type HomeRegion } from './regions';

/**
 * In-region model availability for the optional "Ask HR" assistant (brief §6.13, ADR-0110).
 *
 * This is data, verified against the official AWS documentation on the date recorded with each entry.
 * A region gets a model only when Amazon Bedrock serves a Claude model **In-Region** (single-region,
 * on-demand, bare foundation-model id) in that cell's home AWS region. Geographic (`eu.` / `us.`) and
 * global (`global.`) cross-Region inference profiles route requests to other regions, so they are never
 * used: a region without an in-region model cannot enable the assistant.
 */
export interface InRegionModel {
  available: true;
  provider: 'amazon-bedrock';
  /** Bedrock endpoint family the API calls (InvokeModel on bedrock-runtime). */
  endpoint: 'bedrock-runtime';
  awsRegion: string;
  /** Bare foundation-model id (never an inference-profile id). */
  modelId: string;
  modelName: string;
  sourceUrl: string;
  verifiedOn: string;
}

export interface NoInRegionModel {
  available: false;
  reason: 'no_in_region_model';
  awsRegion: string;
  /** What the documentation offered instead, and why it is not acceptable. */
  note: string;
  sourceUrl: string;
  verifiedOn: string;
}

export type AiModelAvailability = InRegionModel | NoInRegionModel;

const REGION_TABLE = 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html';

export const AI_MODEL_AVAILABILITY: Readonly<Record<HomeRegion, AiModelAvailability>> = Object.freeze({
  uk: {
    available: true,
    provider: 'amazon-bedrock',
    endpoint: 'bedrock-runtime',
    awsRegion: REGIONS.uk.awsRegion,
    modelId: 'anthropic.claude-opus-5-5',
    modelName: 'Claude Opus 5.5',
    sourceUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html',
    verifiedOn: '2026-10-18',
  },
  eu: {
    available: false,
    reason: 'no_in_region_model',
    awsRegion: REGIONS.eu.awsRegion,
    note: 'No Claude model is offered In-Region in eu-central-1 on bedrock-runtime or bedrock-mantle; only the eu. geo profile (routes to Stockholm, Milan, Spain, Ireland and Paris) and global. profiles.',
    sourceUrl: REGION_TABLE,
    verifiedOn: '2026-10-18',
  },
  us: {
    available: false,
    reason: 'no_in_region_model',
    awsRegion: REGIONS.us.awsRegion,
    note: 'No Claude model is offered In-Region in us-east-2 on bedrock-runtime; the us. geo profile routes to us-east-1 and us-west-2. Only Claude Haiku 4.5 is In-Region there, on the separate bedrock-mantle endpoint (not used; see ADR-0110).',
    sourceUrl: REGION_TABLE,
    verifiedOn: '2026-10-18',
  },
});

export function aiModelFor(cell: HomeRegion): AiModelAvailability {
  return AI_MODEL_AVAILABILITY[cell];
}

export function inRegionModel(cell: HomeRegion): InRegionModel | null {
  const m = AI_MODEL_AVAILABILITY[cell];
  return m.available ? m : null;
}

/** Inference-profile prefixes that route outside a single region. Model ids starting with these are refused. */
export const CROSS_REGION_PROFILE_PREFIXES = ['global.', 'us.', 'eu.', 'apac.', 'au.', 'jp.', 'in.', 'ca.', 'us-gov.'] as const;

export function isCrossRegionProfileId(modelId: string): boolean {
  return CROSS_REGION_PROFILE_PREFIXES.some((p) => modelId.startsWith(p)) || /:inference-profile\//.test(modelId) || /:application-inference-profile\//.test(modelId);
}
