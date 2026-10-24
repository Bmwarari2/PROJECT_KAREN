import Link from 'next/link';
import { BookOpen, Search } from 'lucide-react';
import { articlesForContext, helpArticles, searchHelp } from '@thapsus/core/help';
import { buttonVariants, EmptyState, Input, ListItem, ListSection } from '@thapsus/ui';
import { serverContext } from '@/lib/server';
import { PageIntro } from '@/components/module-page';
import { serverSession } from '@/lib/server-session';
import { viewerFromSession } from '../workspace';

/** In-app help centre: versioned, localised articles from the repo, searched with a local index (ADR-0108). */
export default async function HelpPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; context?: string }>;
}) {
  const [{ t, locale }, session] = await Promise.all([serverContext(), serverSession()]);
  const { q = '', context } = await searchParams;
  const query = q.slice(0, 200);
  // only articles about what the reader may do (ADR-0162); without a session, the ones for everyone
  const can = session ? viewerFromSession(session).has : () => false;
  const contextual = context?.startsWith('/app') ? articlesForContext(context, locale, can) : [];
  const results = query.trim() ? searchHelp(query, locale, 10, can) : helpArticles(locale, can);
  // admins contact Thapsus-HR support; everyone else asks their own HR team (ADR-0163)
  const contact = can('support.ticket')
    ? { href: '/app/support', label: t('help.contactSupport') }
    : can('hr.contact')
      ? { href: '/app/contact-hr', label: t('actionable.hr.contact') }
      : null;
  return (
    <div className="flex flex-col gap-6">
      <PageIntro
        title={t('help.title')}
        titleIsTab
        actions={
          contact ? (
            <Link
              href={contact.href}
              className={`${buttonVariants({ variant: 'secondary', size: 'sm' })} no-underline`}
            >
              {contact.label}
            </Link>
          ) : undefined
        }
      />
      <form role="search" action="/app/help" className="flex max-w-xl gap-2 max-sm:flex-col">
        <label htmlFor="help-q" className="sr-only">
          {t('help.searchLabel')}
        </label>
        <Input
          id="help-q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder={t('help.searchPlaceholder')}
        />
        <button type="submit" className={buttonVariants({ size: 'md' })}>
          <Search aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('help.search')}
        </button>
      </form>
      {contextual.length && !query ? (
        <ListSection id="help-context" title={t('help.forThisPage')}>
          {contextual.map((a) => (
            <ListItem
              key={a.slug}
              href={`/app/help/${a.slug}`}
              linkAs={Link}
              leading={<BookOpen aria-hidden />}
              title={a.title}
              subtitle={a.summary}
            />
          ))}
        </ListSection>
      ) : null}
      {results.length ? (
        <div data-testid="help-results" className="contents">
          <ListSection
            id="help-results"
            title={query ? t('help.resultsFor', { query }) : t('help.allArticles')}
          >
            {results.map((a) => (
              <ListItem
                key={a.slug}
                href={`/app/help/${a.slug}`}
                linkAs={Link}
                leading={<BookOpen aria-hidden />}
                title={a.title}
                subtitle={a.summary}
              />
            ))}
          </ListSection>
        </div>
      ) : (
        <section aria-labelledby="help-results-title" className="flex flex-col gap-2">
          <h2 id="help-results-title" className="px-1 text-title-3">
            {t('help.resultsFor', { query })}
          </h2>
          <EmptyState
            level={3}
            icon={<BookOpen aria-hidden />}
            title={t('help.noResults')}
            body={t('help.noResultsBody')}
          />
        </section>
      )}
    </div>
  );
}
