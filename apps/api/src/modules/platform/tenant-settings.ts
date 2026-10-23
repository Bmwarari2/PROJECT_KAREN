import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Type } from 'typebox';
import { FEATURE_FLAGS, FEATURE_KEYS, isFeatureKey, type FeatureKey } from '@thapsus/core/features';
import { checkBrandAccent, HEX_COLOUR, type BrandPalette } from '@thapsus/ui/branding';
import { loadFeatureFlags, setFeatureFlag, type Tx } from '@thapsus/db';
import { authorize, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem } from '../../http/schemas';
import { requireFeature } from '../../lib/features';
import { platformConfig } from './config';

/**
 * Per-tenant feature flags (Settings → Features), custom branding (accent colour within WCAG 2.2 AA
 * contrast limits in light and dark mode, and a logo in the home-region object store) and the
 * "experience" read model the app shell uses to hide disabled features and apply the brand.
 */
const Hex = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });
const Palette = Type.Object({
  accent: Type.String(),
  accentHover: Type.String(),
  onAccent: Type.String(),
  accentSubtle: Type.String(),
});
const ContrastCheck = Type.Object({
  mode: Type.String(),
  pair: Type.String(),
  ratio: Type.Number(),
  required: Type.Number(),
  pass: Type.Boolean(),
});
export const BrandingOut = Type.Object({
  accentLight: Nullable(Type.String()),
  accentDark: Nullable(Type.String()),
  palette: Nullable(Type.Object({ light: Palette, dark: Palette })),
  logo: Nullable(
    Type.Object({
      url: Type.String(),
      contentType: Type.String(),
      bytes: Type.Integer(),
      updatedAt: Type.String(),
    }),
  ),
});
export const FeatureFlagOut = Type.Object({
  key: Type.String(),
  enabled: Type.Boolean(),
  default: Type.Boolean(),
  overridden: Type.Boolean(),
  managedBy: Type.Union([Type.Literal('tenant'), Type.Literal('staff')]),
});

interface Branding {
  accentLight?: string | null;
  accentDark?: string | null;
  palette?: { light: BrandPalette; dark: BrandPalette } | null;
  logo?: { key: string; contentType: string; bytes: number; sha256: string; updatedAt: string } | null;
}

const LOGO_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'image/png': {
    ext: '.png',
    magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': {
    ext: '.webp',
    magic: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
};

export async function featureFlagList(tx: Tx) {
  const stored = await tx.maybe<{ flags: Record<string, unknown> | null }>(
    `SELECT features->'flags' AS flags FROM app.tenants`,
  );
  const resolved = await loadFeatureFlags(tx);
  return FEATURE_KEYS.map((key) => ({
    key,
    enabled: resolved[key],
    default: FEATURE_FLAGS[key].default,
    overridden: typeof stored?.flags?.[key] === 'boolean',
    managedBy: FEATURE_FLAGS[key].managedBy,
  }));
}

const brandingOut = (b: Branding) => ({
  accentLight: b.accentLight ?? null,
  accentDark: b.accentDark ?? null,
  palette: b.palette ?? null,
  logo: b.logo
    ? {
        url: `/v1/branding/logo?v=${b.logo.sha256.slice(0, 12)}`,
        contentType: b.logo.contentType,
        bytes: b.logo.bytes,
        updatedAt: b.logo.updatedAt,
      }
    : null,
});

export async function tenantSettingsRoutes(app: FastifyInstance) {
  const deps = app.deps;
  await app.register(multipart, { limits: { fileSize: platformConfig.branding.maxLogoBytes, files: 1 } });
  const loadBranding = async (tx: Tx) =>
    ((await tx.one<{ branding: Branding }>('SELECT branding FROM app.tenants')).branding ?? {}) as Branding;

  // ---- Experience (every signed-in person) ------------------------------------------------------
  app.get(
    '/v1/tenant/experience',
    {
      schema: {
        tags: ['tenancy'],
        summary: 'Feature flags and branding for the signed-in workspace (the app hides disabled features)',
        response: {
          200: Type.Object({
            kind: Type.String(),
            features: Type.Record(Type.String(), Type.Boolean()),
            branding: Type.Object({
              palette: Nullable(Type.Object({ light: Palette, dark: Palette })),
              logoUrl: Nullable(Type.String()),
            }),
          }),
        },
      },
    },
    async (req) => {
      requireAuth(req);
      return app.tenantTx(
        req,
        async (tx) => {
          const t = await tx.one<{ kind: string; branding: Branding }>(
            'SELECT kind, branding FROM app.tenants',
          );
          const features = await loadFeatureFlags(tx);
          const b = features.customBranding ? brandingOut(t.branding ?? {}) : { palette: null, logo: null };
          return { kind: t.kind, features, branding: { palette: b.palette, logoUrl: b.logo?.url ?? null } };
        },
        { readOnly: true },
      );
    },
  );

  // ---- Feature flags ----------------------------------------------------------------------------
  app.get(
    '/v1/settings/features',
    {
      schema: {
        tags: ['settings'],
        summary: 'Feature flags for this workspace',
        response: { 200: Type.Array(FeatureFlagOut), 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'settings.read');
      return app.tenantTx(req, featureFlagList, { readOnly: true });
    },
  );

  app.put(
    '/v1/settings/features/:key',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        summary: 'Turn a company-managed feature on or off (null restores the default)',
        params: Type.Object({ key: Type.String({ maxLength: 60 }) }),
        body: Type.Object({ enabled: Nullable(Type.Boolean()) }),
        response: { 200: Type.Array(FeatureFlagOut), 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      authorize(req, 'settings.manage');
      const { key } = req.params as { key: string };
      if (!isFeatureKey(key)) throw new ApiError('notFound');
      if (FEATURE_FLAGS[key].managedBy !== 'tenant') throw new ApiError('forbidden', 'staffManagedFeature');
      const { enabled } = req.body as { enabled: boolean | null };
      return app.tenantTx(req, async (tx) => {
        const before = await setFeatureFlag(tx, key as FeatureKey, enabled);
        await app.audit(tx, req, {
          action: 'feature.flag_changed',
          targetType: 'feature_flag',
          targetId: key,
          diff: { from: before, to: enabled },
        });
        return featureFlagList(tx);
      });
    },
  );

  // ---- Branding ---------------------------------------------------------------------------------
  app.get(
    '/v1/settings/branding',
    {
      schema: {
        tags: ['settings'],
        summary: 'Custom branding (accent colour and logo)',
        response: { 200: BrandingOut, 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'settings.read');
      return app.tenantTx(req, async (tx) => brandingOut(await loadBranding(tx)), { readOnly: true });
    },
  );

  app.put(
    '/v1/settings/branding',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        summary:
          'Set the brand accent; refused (422 with the failing contrast pairs) unless WCAG 2.2 AA holds in light and dark mode',
        body: Type.Object(
          { accentLight: Nullable(Hex), accentDark: Type.Optional(Nullable(Hex)) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ ...BrandingOut.properties, checks: Type.Array(ContrastCheck) }),
          403: Problem,
          422: Type.Object({ ...Problem.properties, failures: Type.Array(ContrastCheck) }),
        },
      },
    },
    async (req) => {
      authorize(req, 'settings.manage');
      const b = req.body as { accentLight: string | null; accentDark?: string | null };
      let checks: ReturnType<typeof checkBrandAccent>['checks'] = [];
      let palette: Branding['palette'] = null;
      if (b.accentLight) {
        if (!HEX_COLOUR.test(b.accentLight) || (b.accentDark && !HEX_COLOUR.test(b.accentDark)))
          throw new ApiError('validation');
        const result = checkBrandAccent({ light: b.accentLight, dark: b.accentDark ?? null });
        if (!result.ok)
          throw new ApiError('unprocessable', 'insufficientContrast', { failures: result.failures });
        checks = result.checks;
        palette = result.palette;
      }
      return app.tenantTx(req, async (tx) => {
        await requireFeature(tx, 'customBranding');
        const current = await loadBranding(tx);
        const next: Branding = {
          ...current,
          accentLight: b.accentLight?.toLowerCase() ?? null,
          accentDark: b.accentLight ? (b.accentDark?.toLowerCase() ?? null) : null,
          palette,
        };
        await tx.exec('UPDATE app.tenants SET branding = $1', [JSON.stringify(next)]);
        await app.audit(tx, req, {
          action: 'branding.accent_changed',
          targetType: 'tenant',
          diff: {
            from: { light: current.accentLight ?? null, dark: current.accentDark ?? null },
            to: { light: next.accentLight, dark: next.accentDark },
          },
        });
        return { ...brandingOut(next), checks };
      });
    },
  );

  app.post(
    '/v1/settings/branding/logo',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        summary: 'Upload a logo (PNG, JPEG or WebP; stored in the home-region bucket)',
        consumes: ['multipart/form-data'],
        response: { 200: BrandingOut, 400: Problem, 403: Problem, 413: Problem },
      },
    },
    async (req) => {
      const auth = authorize(req, 'settings.manage');
      const file = await req.file();
      if (!file) throw new ApiError('validation', 'No file');
      const type = LOGO_TYPES[file.mimetype];
      let buf: Buffer;
      try {
        buf = await file.toBuffer();
      } catch {
        throw new ApiError('validation', 'logoTooLarge');
      }
      // Content sniffing, not the declared type: SVG (scriptable) and anything else are refused.
      if (!type || !type.magic(buf)) throw new ApiError('validation', 'unsupportedImage');
      const key = `${auth.tenantId}/branding/logo-${crypto.randomUUID()}${type.ext}`;
      await deps.objects.put(key, buf, file.mimetype);
      const { next, old } = await app.tenantTx(req, async (tx) => {
        await requireFeature(tx, 'customBranding');
        const current = await loadBranding(tx);
        const n: Branding = {
          ...current,
          logo: {
            key,
            contentType: file.mimetype,
            bytes: buf.length,
            sha256: createHash('sha256').update(buf).digest('hex'),
            updatedAt: deps.now().toISOString(),
          },
        };
        await tx.exec('UPDATE app.tenants SET branding = $1', [JSON.stringify(n)]);
        await app.audit(tx, req, {
          action: 'branding.logo_changed',
          targetType: 'tenant',
          diff: { contentType: file.mimetype, bytes: buf.length },
        });
        return { next: n, old: current.logo?.key };
      });
      if (old) await deps.objects.delete(old).catch(() => undefined);
      return brandingOut(next);
    },
  );

  app.delete(
    '/v1/settings/branding/logo',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['settings'],
        summary: 'Remove the logo',
        response: { 200: BrandingOut, 403: Problem },
      },
    },
    async (req) => {
      authorize(req, 'settings.manage');
      const { next, old } = await app.tenantTx(req, async (tx) => {
        const current = await loadBranding(tx);
        const n = { ...current, logo: null };
        await tx.exec('UPDATE app.tenants SET branding = $1', [JSON.stringify(n)]);
        await app.audit(tx, req, { action: 'branding.logo_removed', targetType: 'tenant' });
        return { next: n, old: current.logo?.key };
      });
      if (old) await deps.objects.delete(old).catch(() => undefined);
      return brandingOut(next);
    },
  );

  app.get(
    '/v1/branding/logo',
    {
      schema: {
        tags: ['tenancy'],
        summary: 'The workspace logo image (signed-in users)',
        querystring: Type.Object({ v: Type.Optional(Type.String({ maxLength: 20 })) }),
        response: { 200: Type.String({ contentMediaType: 'image/*' }), 404: Problem },
      },
    },
    async (req, reply) => {
      requireAuth(req);
      const logo = await app.tenantTx(req, async (tx) => (await loadBranding(tx)).logo ?? null, {
        readOnly: true,
      });
      if (!logo) throw new ApiError('notFound');
      const body = await deps.objects.get(logo.key).catch(() => undefined);
      if (!body) throw new ApiError('notFound');
      return reply.type(logo.contentType).header('Content-Disposition', 'inline').send(body);
    },
  );
}
