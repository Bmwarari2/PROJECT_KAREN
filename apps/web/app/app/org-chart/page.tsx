'use client';
import * as React from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { Input, Skeleton } from '@thapsus/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useDebounced } from '@/lib/use-api';
import { PageIntro } from '@/components/module-page';
import { PersonLink } from '@/components/person-link';

interface OrgNode {
  id: string;
  displayName: string;
  jobTitle: string | null;
  department: string | null;
  directReports: number;
}

/** Lazily-loaded org chart: only expanded subtrees are fetched, so it stays fast at 200,000 people. */
function NodeRow({ node, depth, expandTo }: { node: OrgNode; depth: number; expandTo: string[] }) {
  const t = useT();
  const [open, setOpen] = React.useState(expandTo.includes(node.id));
  const [children, setChildren] = React.useState<OrgNode[] | null>(null);
  React.useEffect(() => {
    if (open && !children) void api<OrgNode[]>(`/v1/org-chart/${node.id}/children`).then(setChildren);
  }, [open, children, node.id]);
  return (
    <li
      role="treeitem"
      aria-expanded={node.directReports ? open : undefined}
      aria-level={depth + 1}
      aria-selected={expandTo.at(-1) === node.id}
    >
      <div
        className="flex items-center gap-2 rounded-md py-1.5 pr-2 hover:bg-surface"
        style={{ paddingLeft: `${depth * 20 + 4}px` }}
      >
        {node.directReports ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-label={open ? t('org.collapse') : t('org.expand')}
            className="rounded-sm p-1 text-text-secondary hover:text-text"
          >
            {open ? (
              <ChevronDown aria-hidden className="h-4 w-4 stroke-[1.5]" />
            ) : (
              <ChevronRight aria-hidden className="h-4 w-4 stroke-[1.5]" />
            )}
          </button>
        ) : (
          <span className="w-6" />
        )}
        {/* a link only where the viewer may open the profile (ADR-0161) */}
        <PersonLink
          id={node.id}
          name={node.displayName}
          quiet={expandTo.at(-1) !== node.id}
          className="text-callout"
          plainClassName={expandTo.at(-1) === node.id ? 'font-semibold' : ''}
        />
        <span className="truncate text-footnote text-text-secondary">
          {[node.jobTitle, node.department].filter(Boolean).join(' · ')}
        </span>
        {node.directReports ? (
          <span className="ml-auto text-footnote text-text-secondary">
            {t('org.reports', { count: node.directReports })}
          </span>
        ) : null}
      </div>
      {open && children ? (
        <ul role="group">
          {children.map((c) => (
            <NodeRow key={c.id} node={c} depth={depth + 1} expandTo={expandTo} />
          ))}
        </ul>
      ) : open ? (
        <Skeleton className="ml-10 h-6 w-48" />
      ) : null}
    </li>
  );
}

export default function OrgChartPage() {
  const t = useT();
  const [roots, setRoots] = React.useState<OrgNode[] | null>(null);
  const [q, setQ] = React.useState('');
  const query = useDebounced(q);
  const [results, setResults] = React.useState<OrgNode[]>([]);
  const [focus, setFocus] = React.useState<string[]>([]);
  React.useEffect(() => void api<OrgNode[]>('/v1/org-chart/roots').then(setRoots), []);
  React.useEffect(() => {
    if (!query) return setResults([]);
    void api<OrgNode[]>(`/v1/org-chart/search?q=${encodeURIComponent(query)}`).then(setResults);
  }, [query]);

  async function focusOn(id: string) {
    const f = await api<{ chain: OrgNode[]; node: OrgNode }>(`/v1/org-chart/${id}/focus`);
    setFocus([...f.chain.map((c) => c.id), f.node.id]);
    setRoots(await api<OrgNode[]>('/v1/org-chart/roots'));
    setQ('');
  }
  // global search opens the chart on a person: /app/org-chart?focus=<employee id>
  React.useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('focus');
    if (id && /^[0-9a-f-]{36}$/i.test(id)) void focusOn(id).catch(() => undefined);
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <PageIntro title={t('org.title')} titleIsTab />
      <div className="relative max-w-md">
        <label>
          <span className="sr-only">{t('org.search')}</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-3 h-4 w-4 stroke-[1.5] text-text-secondary"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('org.search')}
            className="pl-9"
            type="search"
          />
        </label>
        {results.length ? (
          <ul className="absolute z-10 mt-1 w-full rounded-md bg-surface-raised p-1 shadow-md">
            {results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="w-full rounded-sm px-3 py-2 text-left text-callout hover:bg-accent-subtle"
                  onClick={() => focusOn(r.id)}
                >
                  {r.displayName} <span className="text-text-secondary">{r.jobTitle}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {roots ? (
        <ul
          role="tree"
          aria-label={t('org.title')}
          key={focus.join()}
          className="rounded-lg border border-border p-2"
        >
          {roots.map((r) => (
            <NodeRow key={r.id} node={r} depth={0} expandTo={focus} />
          ))}
        </ul>
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
    </div>
  );
}
