import Link from 'next/link';
import { BookOpen, Search } from 'lucide-react';
import { articlesForContext, helpArticles, searchHelp } from '@thapsus/core/help';
import { buttonVariants, Card, EmptyState, Input } from '@thapsus/ui';
import { serverContext } from '@/lib/server';

/** In-app help centre: versioned, localised articles from the repo, searched with a local index (ADR-0108). */
export default async function HelpPage({ searchParams }: { searchParams: Promise<{ q?: string; context?: string }> }) {
  const { t, locale } = await serverContext();
  const { q = '', context } = await searchParams;
  const query = q.slice(0, 200);
  const contextual = context?.startsWith('/app') ? articlesForContext(context, locale) : [];
  const results = query.trim() ? searchHelp(query, locale) : helpArticles(locale);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title-2">{t('help.title')}</h1>
        <Link href="/app/support" className={`${buttonVariants({ variant: 'secondary', size: 'sm' })} no-underline`}>
          {t('help.contactSupport')}
        </Link>
      </div>
      <form role="search" action="/app/help" className="flex max-w-xl gap-2">
        <label htmlFor="help-q" className="sr-only">
          {t('help.searchLabel')}
        </label>
        <Input id="help-q" name="q" type="search" defaultValue={query} placeholder={t('help.searchPlaceholder')} />
        <button type="submit" className={buttonVariants({ size: 'md' })}>
          <Search aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('help.search')}
        </button>
      </form>
      {contextual.length && !query ? (
        <section aria-labelledby="help-context">
          <h2 id="help-context" className="text-title-3">
            {t('help.forThisPage')}
          </h2>
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {contextual.map((a) => (
              <li key={a.slug}>
                <Card>
                  <Link href={`/app/help/${a.slug}`} className="text-callout font-semibold">
                    {a.title}
                  </Link>
                  <p className="mt-1 text-callout text-text-secondary">{a.summary}</p>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="help-results">
        <h2 id="help-results" className="text-title-3">
          {query ? t('help.resultsFor', { query }) : t('help.allArticles')}
        </h2>
        {results.length ? (
          <ul className="mt-3 grid gap-3 md:grid-cols-2" data-testid="help-results">
            {results.map((a) => (
              <li key={a.slug}>
                <Card>
                  <Link href={`/app/help/${a.slug}`} className="text-callout font-semibold">
                    {a.title}
                  </Link>
                  <p className="mt-1 text-callout text-text-secondary">{a.summary}</p>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3">
            <EmptyState icon={<BookOpen aria-hidden />} title={t('help.noResults')} body={t('help.noResultsBody')} />
          </div>
        )}
      </section>
    </div>
  );
}
