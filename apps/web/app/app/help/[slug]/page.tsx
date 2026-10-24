import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { helpArticle, type HelpArticleView } from '@thapsus/core/help';
import { formatDate } from '@thapsus/core/i18n';
import { buttonVariants } from '@thapsus/ui';
import { serverContext } from '@/lib/server';
import { serverApiResult } from '@/lib/server-api';
import { PageTitle } from '../../shell';
import { serverSession } from '@/lib/server-session';
import { viewerFromSession } from '../../workspace';
import { fallbackReader } from '../reader';

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ t, locale }, session] = await Promise.all([serverContext(), serverSession()]);
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) notFound();
  // an article that is not for this reader is not found (ADR-0162, ADR-0190): the API decides with the
  // workspace's features and countries; the stricter local reader only if the API does not answer
  const fromApi = await serverApiResult<HelpArticleView>(
    `/v1/help/articles/${slug}?${new URLSearchParams({ locale })}`,
  );
  const a = fromApi ? fromApi.data : helpArticle(slug, locale, fallbackReader(session));
  if (!a) notFound();
  const viewer = session ? viewerFromSession(session) : null;
  const stuck = viewer?.can('help.support')
    ? {
        href: `/app/support?new=1&context=${encodeURIComponent(a.contexts[0] ?? '/app')}`,
        label: t('help.raiseTicket'),
      }
    : viewer?.can('help.contactHr')
      ? { href: '/app/contact-hr', label: t('actionable.hr.contact') }
      : null;
  return (
    <article className="flex max-w-[var(--prose-width)] flex-col gap-4">
      <Link href="/app/help" className="inline-flex items-center gap-1 text-callout">
        <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('help.back')}
      </Link>
      <PageTitle>{a.title}</PageTitle>
      <p className="text-body-lg text-text-secondary">{a.summary}</p>
      {a.body.map((p, i) => (
        <p key={i} className="text-body">
          {p}
        </p>
      ))}
      <p className="text-footnote text-text-secondary">
        {t('help.updated', { date: formatDate(a.updatedOn, locale), version: a.version })}
      </p>
      {stuck ? (
        <div className="mt-4 rounded-lg bg-surface p-5">
          <p className="text-callout">{t('help.stillStuck')}</p>
          <Link href={stuck.href} className={`${buttonVariants({ size: 'sm' })} mt-3 no-underline`}>
            {stuck.label}
          </Link>
        </div>
      ) : null}
    </article>
  );
}
