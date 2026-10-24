'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, CornerDownLeft, LayoutGrid, Search, UserRound, Zap } from 'lucide-react';
import { CommandDialog as DialogPrimitive, cn } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-api';
import { useT } from '@/lib/i18n-client';
import { visibleActions, visibleModules, type WorkspaceViewer } from '@/app/app/workspace';

/**
 * Global search (ADR-0154): one box for people, pages, actions and help articles, opened from the
 * top bar or with Ctrl/⌘ K. Pages and actions come from the workspace map, already filtered to what the
 * viewer may open; people come from the org-chart directory search (names and job titles everyone in
 * the workspace can see) and open the full profile only for those allowed to read it. Recents keep
 * pages and actions only, never people, in this browser.
 */
type Group = 'recent' | 'actions' | 'pages' | 'people' | 'help';
interface Result {
  id: string;
  group: Group;
  label: string;
  detail?: string;
  href: string;
  kind: 'page' | 'action' | 'person' | 'help';
}

const RECENT_MAX = 5;
const recentKey = (userId: string) => `thr.search.recent.${userId}`;
function readRecent(userId: string): Result[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(userId)) ?? '[]');
    return Array.isArray(v) ? (v as Result[]).filter((r) => r.kind === 'page' || r.kind === 'action') : [];
  } catch {
    return [];
  }
}
function remember(userId: string, r: Result) {
  if (r.kind !== 'page' && r.kind !== 'action') return;
  try {
    const next = [{ ...r, group: 'recent' as const }, ...readRecent(userId).filter((x) => x.href !== r.href)];
    localStorage.setItem(recentKey(userId), JSON.stringify(next.slice(0, RECENT_MAX)));
  } catch {
    // storage blocked: search still works without recents
  }
}

const norm = (s: string) => s.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
function score(q: string, ...fields: Array<string | undefined>): number {
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    const n = norm(f);
    if (n === q) best = Math.max(best, 4);
    else if (n.startsWith(q)) best = Math.max(best, 3);
    else if (n.split(/\s+/).some((w) => w.startsWith(q))) best = Math.max(best, 2);
    else if (n.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

export function GlobalSearch({
  open,
  onOpenChange,
  viewer,
  userId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viewer: WorkspaceViewer;
  userId: string;
}) {
  const t = useT();
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const [people, setPeople] = React.useState<Result[]>([]);
  const [help, setHelp] = React.useState<Result[]>([]);
  const [recent, setRecent] = React.useState<Result[]>([]);
  const q = norm(query.trim());
  const debounced = useDebounced(q, 200);

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setRecent(readRecent(userId));
    }
  }, [open, userId]);

  const modules = React.useMemo(() => visibleModules(viewer), [viewer]);
  const pages = React.useMemo<Result[]>(
    () =>
      modules.flatMap((m) =>
        m.tabs.map((tab) => ({
          id: `page:${tab.href}`,
          group: 'pages' as const,
          kind: 'page' as const,
          label: t(tab.label) === t(m.label) ? t(m.label) : t(tab.label),
          detail: t(tab.label) === t(m.label) ? t(m.description) : t(m.label),
          href: tab.href,
        })),
      ),
    [modules, t],
  );
  const actions = React.useMemo<Result[]>(
    () =>
      visibleActions(viewer).map((a) => ({
        id: `action:${a.key}`,
        group: 'actions' as const,
        kind: 'action' as const,
        label: t(a.label),
        href: a.href,
      })),
    [viewer, t],
  );

  // people and help articles come from the API once two characters are typed
  React.useEffect(() => {
    if (!open || debounced.length < 2) {
      setPeople([]);
      setHelp([]);
      return;
    }
    let cancelled = false;
    const term = encodeURIComponent(debounced);
    api<Array<{ id: string; displayName: string; jobTitle: string | null; department: string | null }>>(
      `/v1/org-chart/search?q=${term}`,
    )
      .then(async (rows) => {
        if (cancelled) return;
        const top = rows.slice(0, 6);
        // a profile only where the viewer may open it (ADR-0161); everyone else on the org chart
        let open = new Set<string>(viewer.employeeId ? [viewer.employeeId] : []);
        if (viewer.can('people.directory') && viewer.can('people.visibility') && top.length) {
          const r = await api<{ all: boolean; visible: string[] }>('/v1/people/visibility', {
            method: 'POST',
            json: { ids: top.map((p) => p.id) },
            capability: 'people.visibility',
          }).catch(() => ({ all: false, visible: [] as string[] }));
          open = r.all ? new Set(top.map((p) => p.id)) : new Set([...open, ...r.visible]);
        }
        if (cancelled) return;
        setPeople(
          top.map((p) => ({
            id: `person:${p.id}`,
            group: 'people',
            kind: 'person',
            label: p.displayName,
            detail: [p.jobTitle, p.department].filter(Boolean).join(' · ') || undefined,
            href: open.has(p.id) ? `/app/people/${p.id}` : `/app/org-chart?focus=${p.id}`,
          })),
        );
      })
      .catch(() => !cancelled && setPeople([]));
    api<Array<{ slug: string; title: string; summary: string }>>(`/v1/help/articles?q=${term}`)
      .then((rows) => {
        if (cancelled) return;
        setHelp(
          rows.slice(0, 4).map((a) => ({
            id: `help:${a.slug}`,
            group: 'help',
            kind: 'help',
            label: a.title,
            detail: a.summary,
            href: `/app/help/${a.slug}`,
          })),
        );
      })
      .catch(() => !cancelled && setHelp([]));
    return () => {
      cancelled = true;
    };
  }, [open, debounced, viewer]);

  const groups = React.useMemo<Array<[Group, Result[]]>>(() => {
    if (!q) {
      return (
        [
          ['recent', recent],
          ['actions', actions.slice(0, 5)],
          ['pages', pages.filter((p) => !recent.some((r) => r.href === p.href)).slice(0, 6)],
        ] as Array<[Group, Result[]]>
      ).filter(([, rs]) => rs.length);
    }
    const rank = (rs: Result[]) =>
      rs
        .map((r) => [score(q, r.label, r.detail), r] as const)
        .filter(([s]) => s > 0)
        .sort((a, b) => b[0] - a[0])
        .map(([, r]) => r);
    return (
      [
        ['people', people],
        ['actions', rank(actions).slice(0, 4)],
        ['pages', rank(pages).slice(0, 6)],
        ['help', help],
      ] as Array<[Group, Result[]]>
    ).filter(([, rs]) => rs.length);
  }, [q, recent, actions, pages, people, help]);
  const flat = groups.flatMap(([, rs]) => rs);
  React.useEffect(() => setActive(0), [q, people.length, help.length]);

  const go = (r: Result | undefined) => {
    if (!r) return;
    remember(userId, r);
    onOpenChange(false);
    router.push(r.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(flat[active]);
    }
  };

  // keep the highlighted option in view while moving with the keyboard
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const icon = (r: Result) =>
    r.kind === 'person' ? (
      <UserRound />
    ) : r.kind === 'action' ? (
      <Zap />
    ) : r.kind === 'help' ? (
      <BookOpen />
    ) : (
      <LayoutGrid />
    );
  let index = -1;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-surface-inverse/50" />
        <DialogPrimitive.Content
          aria-describedby="gs-hint"
          className="fixed left-1/2 top-[max(16px,10vh)] z-50 flex max-h-[min(640px,80dvh)] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-raised text-text shadow-lg"
        >
          <DialogPrimitive.Title className="sr-only">{t('app.ws.search.title')}</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5] text-text-secondary" />
            <input
              id="gs-input"
              role="combobox"
              aria-expanded="true"
              aria-controls="gs-list"
              aria-autocomplete="list"
              aria-activedescendant={flat[active] ? `gs-opt-${active}` : undefined}
              aria-label={t('app.ws.search.label')}
              placeholder={t('app.ws.search.placeholder')}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className="h-14 min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-secondary"
            />
            <kbd className="hidden rounded border border-border px-1.5 text-footnote text-text-secondary sm:inline">
              {t('app.ws.search.escKey')}
            </kbd>
          </div>
          <div
            ref={listRef}
            id="gs-list"
            role="listbox"
            aria-label={t('app.ws.search.results')}
            className="min-h-0 flex-1 overflow-y-auto p-2"
          >
            {groups.length === 0 ? (
              <p className="px-3 py-8 text-center text-callout text-text-secondary">
                {q.length < 2
                  ? t('app.ws.search.keepTyping')
                  : t('app.ws.search.noResults', { query: query.trim() })}
              </p>
            ) : (
              groups.map(([g, rs]) => (
                <div key={g} role="group" aria-labelledby={`gs-g-${g}`} className="mb-2">
                  <p id={`gs-g-${g}`} className="px-3 py-1.5 text-footnote font-semibold text-text-secondary">
                    {t(`app.ws.search.group.${g}`)}
                  </p>
                  {rs.map((r) => {
                    index += 1;
                    const i = index;
                    return (
                      <div
                        key={r.id + i}
                        id={`gs-opt-${i}`}
                        data-index={i}
                        role="option"
                        aria-selected={i === active}
                        onMouseMove={() => setActive(i)}
                        onClick={() => go(r)}
                        className={cn(
                          'flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 [&>svg]:h-5 [&>svg]:w-5 [&>svg]:shrink-0 [&>svg]:stroke-[1.5] [&>svg]:text-text-secondary',
                          i === active ? 'bg-accent-subtle' : '',
                        )}
                      >
                        {icon(r)}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-callout text-text">{r.label}</span>
                          {r.detail ? (
                            <span className="block truncate text-footnote text-text-secondary">
                              {r.detail}
                            </span>
                          ) : null}
                        </span>
                        {i === active ? (
                          <CornerDownLeft aria-hidden className="!h-4 !w-4" />
                        ) : (
                          <ArrowRight aria-hidden className="!h-4 !w-4 opacity-0" />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          <p id="gs-hint" className="border-t border-border px-4 py-2 text-footnote text-text-secondary">
            {t('app.ws.search.hint')}
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
