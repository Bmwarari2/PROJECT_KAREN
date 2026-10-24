import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import webpush from 'web-push';
import { isLocale, t } from '@thapsus/core/i18n';
import { isValidTimeZone } from '@thapsus/core/time';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Problem } from '../../http/schemas';

export async function meRoutes(app: FastifyInstance) {
  const deps = app.deps;

  app.patch(
    '/v1/me/preferences',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['me'],
        body: Type.Object(
          { locale: Type.Optional(Type.String()), timeZone: Type.Optional(Type.String({ maxLength: 64 })) },
          { additionalProperties: false },
        ),
        response: { 204: Type.Null(), 400: Problem },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { locale?: string; timeZone?: string };
      if (b.locale && !isLocale(b.locale)) throw new ApiError('validation');
      if (b.timeZone && !isValidTimeZone(b.timeZone)) throw new ApiError('validation');
      await app.tenantTx(req, async (tx) => {
        await tx.exec(
          'UPDATE app.users SET locale = coalesce($2, locale), time_zone = coalesce($3, time_zone) WHERE id = $1',
          [auth.userId, b.locale ?? null, b.timeZone ?? null],
        );
        await app.audit(tx, req, {
          action: 'user.preferences_updated',
          targetType: 'user',
          targetId: auth.userId,
          diff: b,
        });
      });
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/v1/push/vapid-public-key',
    {
      config: { auth: 'public' },
      schema: {
        tags: ['me'],
        response: { 200: Type.Object({ publicKey: Type.Union([Type.String(), Type.Null()]) }) },
      },
    },
    async () => ({
      publicKey: deps.webPush?.publicKey ?? null,
    }),
  );

  app.post(
    '/v1/me/push-subscriptions',
    {
      config: { selfAudited: true, capability: 'me.notifications' },
      schema: {
        tags: ['me'],
        body: Type.Object({
          endpoint: Type.String({ format: 'uri', maxLength: 1000 }),
          keys: Type.Object({
            p256dh: Type.String({ maxLength: 200 }),
            auth: Type.String({ maxLength: 100 }),
          }),
        }),
        response: { 201: Type.Object({ id: Type.String() }) },
      },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const b = req.body as { endpoint: string; keys: { p256dh: string; auth: string } };
      const row = await app.tenantTx(req, async (tx) => {
        const r = await tx.one<{ id: string }>(
          `INSERT INTO app.push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth) VALUES (app.current_tenant(), $1, $2, $3, $4)
           ON CONFLICT (tenant_id, endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth RETURNING id`,
          [auth.userId, b.endpoint, b.keys.p256dh, b.keys.auth],
        );
        await app.audit(tx, req, {
          action: 'push.subscribed',
          targetType: 'push_subscription',
          targetId: r.id,
        });
        return r;
      });
      return reply.status(201).send(row);
    },
  );

  app.post(
    '/v1/me/push-test',
    {
      config: { selfAudited: true, capability: 'me.notifications' },
      schema: { tags: ['me'], response: { 202: Type.Object({ sent: Type.Integer() }), 422: Problem } },
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      if (!deps.webPush) throw new ApiError('unprocessable', 'Web push is not configured');
      const subs = await app.tenantTx(req, async (tx) => {
        await app.audit(tx, req, { action: 'push.test_sent', targetType: 'user', targetId: auth.userId });
        return tx.query<{ endpoint: string; p256dh: string; auth: string }>(
          'SELECT endpoint, p256dh, auth FROM app.push_subscriptions WHERE user_id = $1',
          [auth.userId],
        );
      });
      const locale = isLocale(auth.user.locale) ? auth.user.locale : req.ctx.locale;
      let sent = 0;
      for (const s of subs) {
        await webpush
          .sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ title: t(locale, 'common.appName'), body: t(locale, 'push.testBody') }),
            { vapidDetails: deps.webPush, TTL: 60 },
          )
          .then(() => sent++)
          .catch((err) => req.log.warn({ err }, 'push failed'));
      }
      return reply.status(202).send({ sent });
    },
  );
}
