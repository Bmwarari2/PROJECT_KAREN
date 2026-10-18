import { Badge } from '@thapsus/ui';
import { serverContext } from '@/lib/server';

/**
 * A crisp, resolution-independent "screenshot" of Thapsus-HR rendered from real components and
 * fictional data — no raster image to download, so it is fast on low-cost phones.
 */
export async function ProductMock() {
  const { t } = await serverContext();
  const rows = [
    { name: 'Avery Example', role: t('marketing.mock.roleEngineer'), status: 'success' as const, label: t('marketing.mock.statusActive') },
    { name: 'Blake Sample', role: t('marketing.mock.roleDesigner'), status: 'warning' as const, label: t('marketing.mock.statusLeave') },
    { name: 'Casey Fictional', role: t('marketing.mock.roleSupport'), status: 'accent' as const, label: t('marketing.mock.statusStarting') },
  ];
  return (
    <figure className="mx-auto max-w-[var(--content-wide)]">
      <div className="overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg">
        <div className="flex h-10 items-center gap-2 border-b border-border bg-surface px-4">
          <span className="h-2.5 w-2.5 rounded-pill bg-border" />
          <span className="h-2.5 w-2.5 rounded-pill bg-border" />
          <span className="h-2.5 w-2.5 rounded-pill bg-border" />
        </div>
        <div className="grid md:grid-cols-[200px_1fr]">
          <div className="hidden flex-col gap-2 border-r border-border bg-surface p-4 text-callout text-text-secondary md:flex">
            <span className="rounded-md bg-accent-subtle px-3 py-1.5 font-semibold text-text">{t('marketing.mock.people')}</span>
            <span className="px-3 py-1.5">{t('marketing.mock.timeOff')}</span>
            <span className="px-3 py-1.5">{t('marketing.mock.rota')}</span>
            <span className="px-3 py-1.5">{t('marketing.mock.reports')}</span>
          </div>
          <div className="p-5 text-left md:p-8">
            <p className="text-title-3">{t('marketing.mock.people')}</p>
            <ul className="mt-4 divide-y divide-border">
              {rows.map((r) => (
                <li key={r.name} className="flex items-center gap-3 py-3">
                  <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-pill bg-accent-subtle text-footnote font-semibold text-accent">
                    {r.name.split(' ').map((p) => p[0]).join('')}
                  </span>
                  <span className="flex-1">
                    <span className="block text-callout font-semibold">{r.name}</span>
                    <span className="block text-footnote text-text-secondary">{r.role}</span>
                  </span>
                  <Badge tone={r.status}>{r.label}</Badge>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">{t('marketing.mock.caption')}</figcaption>
    </figure>
  );
}
