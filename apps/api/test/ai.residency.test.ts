import { describe, expect, it } from 'vitest';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { HOME_REGIONS, REGIONS, regionPairs, ResidencyViolationError, type HomeRegion } from '@thapsus/core';
import {
  AI_MODEL_AVAILABILITY,
  CROSS_REGION_PROFILE_PREFIXES,
  inRegionModel,
  isCrossRegionProfileId,
  type InRegionModel,
} from '@thapsus/core/ai-models';
import { createAwsClientFactory } from '@thapsus/core/aws';
import {
  aiProviderFromEnv,
  AiUnavailableError,
  BedrockClaudeProvider,
  FakeAiProvider,
} from '../src/modules/ai/provider';

/**
 * Residency for Ask HR: the Bedrock client is built only through the residency-guarded factory, in the
 * cell's home region, with a bare in-region model id. Cross-Region inference profiles (which route
 * requests to other regions) are refused, and cells without an in-region model get no provider.
 */
const UK = inRegionModel('uk')!;
const fakeCredentials = { accessKeyId: 'AKIDFICTIONAL', secretAccessKey: 'fictional-secret' };

describe.each(regionPairs())('Bedrock residency %s → %s', (home: HomeRegion, other: HomeRegion) => {
  it(`a ${home} cell refuses a Bedrock runtime client in ${other} (runtime and backup purposes)`, () => {
    const create = createAwsClientFactory({ cell: home });
    expect(() =>
      create(BedrockRuntimeClient, 'bedrock-runtime', { region: REGIONS[other].awsRegion }),
    ).toThrow(ResidencyViolationError);
    expect(() =>
      create(BedrockRuntimeClient, 'bedrock-runtime', { region: REGIONS[other].awsRegion }, 'backup'),
    ).toThrow(ResidencyViolationError);
  });
  it(`a ${home} provider refuses a model hosted in ${other}`, () => {
    const foreign: InRegionModel = { ...UK, awsRegion: REGIONS[other].awsRegion };
    expect(() => new BedrockClaudeProvider(home, { model: foreign })).toThrow(ResidencyViolationError);
  });
});

describe('in-region model map (ADR-0110)', () => {
  it.each(HOME_REGIONS)(
    '%s: an available model is in the home region with a bare foundation-model id',
    (cell) => {
      const m = AI_MODEL_AVAILABILITY[cell];
      expect(m.awsRegion).toBe(REGIONS[cell].awsRegion);
      expect(m.sourceUrl).toMatch(/^https:\/\/docs\.aws\.amazon\.com\/bedrock\//);
      expect(m.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (m.available) expect(isCrossRegionProfileId(m.modelId)).toBe(false);
      else expect(m.note).toMatch(/In-Region/);
    },
  );
  it('records what was verified: UK has Claude Opus 5.5 in eu-west-2; EU and US have no in-region model', () => {
    expect(inRegionModel('uk')).toMatchObject({
      awsRegion: 'eu-west-2',
      modelId: 'anthropic.claude-opus-5-5',
      endpoint: 'bedrock-runtime',
    });
    expect(inRegionModel('eu')).toBeNull();
    expect(inRegionModel('us')).toBeNull();
  });
  it.each(CROSS_REGION_PROFILE_PREFIXES.map((p) => [p] as const))(
    'refuses the %s cross-Region inference profile even in the home region',
    (prefix) => {
      expect(
        () =>
          new BedrockClaudeProvider('uk', {
            model: { ...UK, modelId: `${prefix}anthropic.claude-opus-5-5` },
          }),
      ).toThrow(/cross-Region/);
    },
  );
  it('refuses inference-profile ARNs', () => {
    expect(
      isCrossRegionProfileId(
        'arn:aws:bedrock:eu-west-2:123456789012:inference-profile/eu.anthropic.claude-opus-5-5',
      ),
    ).toBe(true);
    expect(
      isCrossRegionProfileId('arn:aws:bedrock:eu-west-2:123456789012:application-inference-profile/abc'),
    ).toBe(true);
  });
});

describe('provider selection', () => {
  it.each(['eu', 'us'] as const)('%s: no in-region model means no provider, in every environment', (cell) => {
    expect(() => new BedrockClaudeProvider(cell)).toThrow(AiUnavailableError);
    expect(aiProviderFromEnv(cell, { APP_ENV: 'prod' })).toBeUndefined();
    expect(aiProviderFromEnv(cell, { APP_ENV: 'staging', AI_PROVIDER: 'bedrock' })).toBeUndefined();
  });
  it('uk uses Bedrock in AWS environments and the fake only when chosen outside production', () => {
    expect(aiProviderFromEnv('uk', { APP_ENV: 'prod' })).toBeInstanceOf(BedrockClaudeProvider);
    expect(aiProviderFromEnv('uk', { APP_ENV: 'test', AI_PROVIDER: 'fake' })).toBeInstanceOf(FakeAiProvider);
    expect(aiProviderFromEnv('uk', { APP_ENV: 'dev', AI_PROVIDER: 'none' })).toBeUndefined();
    expect(() => aiProviderFromEnv('uk', { APP_ENV: 'prod', AI_PROVIDER: 'fake' })).toThrow(
      /never run in production/,
    );
  });
  it('off (like none) keeps Ask HR unavailable in every environment; an unknown choice stops the service (ADR-0156)', () => {
    for (const APP_ENV of ['dev', 'test', 'staging', 'prod'])
      for (const AI_PROVIDER of ['off', 'none'])
        expect(
          aiProviderFromEnv('uk', { APP_ENV, AI_PROVIDER }),
          `${APP_ENV} ${AI_PROVIDER}`,
        ).toBeUndefined();
    // A typo must not fall back to Bedrock (unreachable from Google Cloud) or to fake answers.
    for (const AI_PROVIDER of ['of', 'OFF', 'vertex', 'bedrok'])
      expect(() => aiProviderFromEnv('uk', { APP_ENV: 'staging', AI_PROVIDER }), AI_PROVIDER).toThrow(
        /AI_PROVIDER must be one of bedrock, fake, none or off/,
      );
    // An empty value means unset, as before.
    expect(aiProviderFromEnv('uk', { APP_ENV: 'prod', AI_PROVIDER: '' })).toBeInstanceOf(
      BedrockClaudeProvider,
    );
  });
});

describe('the request a UK cell sends', () => {
  it('goes to bedrock-runtime in eu-west-2 for the bare model id, carrying only the given prompt', async () => {
    const provider = new BedrockClaudeProvider('uk', { client: { credentials: fakeCredentials } });
    expect(await provider.client.config.region()).toBe('eu-west-2');
    let captured: { hostname: string; path: string; body: string } | undefined;
    provider.client.middlewareStack.add(
      (_next) => async (args) => {
        const req = args.request as { hostname: string; path: string; body: string };
        captured = { hostname: req.hostname, path: req.path, body: String(req.body) };
        throw new Error('captured');
      },
      { step: 'finalizeRequest', name: 'captureForTest', priority: 'low' },
    );
    await expect(provider.complete({ system: 'SYSTEM', user: 'USER TURN', maxTokens: 100 })).rejects.toThrow(
      'captured',
    );
    expect(captured!.hostname).toBe('bedrock-runtime.eu-west-2.amazonaws.com');
    expect(decodeURIComponent(captured!.path)).toBe('/model/anthropic.claude-opus-5-5/invoke');
    const body = JSON.parse(captured!.body);
    expect(body).toEqual({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 100,
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'USER TURN' }] }],
    });
  });
});
