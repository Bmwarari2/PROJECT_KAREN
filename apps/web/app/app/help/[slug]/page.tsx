import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { helpArticle } from '@thapsus/core/help';
import { formatDate } from '@thapsus/core/i18n';
import { buttonVariants } from '@thapsus/ui';
import { serverContext } from '@/lib/server';
import { PageTitle } from '../../shell';
import { serverSession } from '@/lib/server-session';
import { viewerFromSession } from '../../workspace';

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ t, locale }, session] = await Promise.all([serverContext(), serverSession()]);
  const { slug } = await params;
  // an article that is not for this reader is not found (ADR-0162)
  const can = session ? viewerFromSession(session).has : () => false;
  const a = /^[a-z0-9-]{1,80}$/.test(slug) ? helpArticle(slug, locale, can) : undefined;
  if (!a) notFound();
  const stuck = can('support.ticket')
    ? {
        href: `/app/support?new=1&context=${encodeURIComponent(a.contexts[0] ?? '/app')}`,
        label: t('help.raiseTicket'),
      }
    : can('hr.contact')
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
