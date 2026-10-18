import webpush from 'web-push';
import { enqueueJob } from '@thapsus/db';
import { isLocale, t } from '@thapsus/core/i18n';
import { periodic, registerJob } from './registry';

// ---- Core HR: future-dated changes take effect on their date --------------------------------
registerJob('employees.refresh_effective', async (ctx) => {
  const date = String(ctx.job.input.date);
  const n = await ctx.tx(async (tx) => {
    const changed = await tx.query<{ employee_id: string }>(
      `SELECT DISTINCT employee_id FROM (
         SELECT employee_id FROM app.employee_jobs WHERE valid_from = $1 OR valid_to = $1
         UNION SELECT employee_id FROM app.employee_personal WHERE valid_from = $1 OR valid_to = $1
         UNION SELECT employee_id FROM app.reporting_lines WHERE valid_from = $1 OR valid_to = $1
         UNION SELECT id FROM app.employees WHERE start_date = $1 OR end_date = ($1::date - 1)
         UNION SELECT id FROM app.employees WHERE current_as_of IS NULL OR current_as_of < ($1::date - 1)
       ) x`,
      [date],
    );
    for (const c of changed) await tx.query('SELECT app.refresh_employee_current($1, $2)', [c.employee_id, date]);
    return changed.length;
  });
  return { date, refreshed: n };
});

periodic.push(async (tx, now) => {
  const date = now.toISOString().slice(0, 10);
  await enqueueJob(tx, 'employees.refresh_effective', date, { date });
});

// ---- Notification delivery: email from the home region + web push ------------------------------
registerJob('notifications.deliver', async (ctx) => {
  const id = String(ctx.job.input.notificationId);
  const n = await ctx.tx((tx) =>
    tx.maybe<{ id: string; title_key: string; params: Record<string, string>; link: string | null; emailed_at: string | null; email: string; locale: string | null; user_id: string }>(
      `SELECT n.id, n.title_key, n.params, n.link, n.emailed_at, u.email, u.locale, n.user_id FROM app.notifications n JOIN app.users u ON u.tenant_id = n.tenant_id AND u.id = n.user_id WHERE n.id = $1`,
      [id],
    ),
  );
  if (!n || n.emailed_at) return { skipped: true };
  const locale = isLocale(n.locale) ? n.locale : 'en-GB';
  const title = t(locale, n.title_key, n.params);
  const link = n.link ? `${ctx.deps.config.appBaseUrl}${n.link}` : ctx.deps.config.appBaseUrl;
  await ctx.deps.mailer.send({ to: n.email, subject: title, text: `${title}\n\n${link}` });
  if (ctx.deps.webPush) {
    const subs = await ctx.tx((tx) => tx.query<{ endpoint: string; p256dh: string; auth: string }>('SELECT endpoint, p256dh, auth FROM app.push_subscriptions WHERE user_id = $1', [n.user_id]));
    for (const s of subs) {
      await webpush
        .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: t(locale, 'common.appName'), body: title, url: n.link ?? '/app' }), { vapidDetails: ctx.deps.webPush, TTL: 3600 })
        .catch(() => undefined);
    }
  }
  await ctx.tx((tx) => tx.exec('UPDATE app.notifications SET emailed_at = now() WHERE id = $1', [id]));
  return { delivered: true };
});
