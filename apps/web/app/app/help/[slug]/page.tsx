import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { helpArticle } from '@thapsus/core/help';
import { formatDate } from '@thapsus/core/i18n';
import { buttonVariants } from '@thapsus/ui';
import { serverContext } from '@/lib/server';

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { t, locale } = await serverContext();
  const { slug } = await params;
  const a = /^[a-z0-9-]{1,80}$/.test(slug) ? helpArticle(slug, locale) : undefined;
  if (!a) notFound();
  return (
    <article className="flex max-w-[var(--prose-width)] flex-col gap-4">
      <Link href="/app/help" className="inline-flex items-center gap-1 text-callout">
        <ArrowLeft aria-hidden className="h-4 w-4 stroke-[1.5]" />
        {t('help.back')}
      </Link>
      <h1 className="text-title-2">{a.title}</h1>
      <p className="text-body-lg text-text-secondary">{a.summary}</p>
      {a.body.map((p, i) => (
        <p key={i} className="text-body">
          {p}
        </p>
      ))}
      <p className="text-footnote text-text-secondary">{t('help.updated', { date: formatDate(a.updatedOn, locale), version: a.version })}</p>
      <div className="mt-4 rounded-lg bg-surface p-5">
        <p className="text-callout">{t('help.stillStuck')}</p>
        <Link href={`/app/support?new=1&context=${encodeURIComponent(a.contexts[0] ?? '/app')}`} className={`${buttonVariants({ size: 'sm' })} mt-3 no-underline`}>
          {t('help.raiseTicket')}
        </Link>
      </div>
    </article>
  );
}
