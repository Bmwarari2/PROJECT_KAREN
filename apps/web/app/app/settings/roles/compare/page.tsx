'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Check, Eye, Info, ShieldCheck } from 'lucide-react';
import { Badge, Card, CardTitle, cn, EmptyState, Field, Input, Skeleton, TableToolbar } from '@thapsus/ui';
import { BUILT_IN_ROLES } from '@thapsus/core/roles';
import { actionMatches, grantFieldAccess } from '@thapsus/core/permissions';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { ModuleFrameContext, PageTitle } from '../../../shell';
import { GROUPS, type WorkspaceModule } from '../../../workspace';
import { SETTINGS_GROUPS } from '../../sections';
import { sectionMessages } from '../../section-text';
import { selectClass } from '../../kit';
import { RolesNav } from '../nav';
import { rolePreview } from '../preview';
import { fieldLabel, permissionLabel, roleName, type Catalogue, type FieldLevel, type Role } from '../shared';

const norm = (s: string) => s.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const holds = (r: Role, key: string) => r.permissions.some((g) => actionMatches(g, key));
/** The level a role gives a field, resolved the way the engine resolves it (exact key, then wildcards). */
const levelOf = (r: Role, key: string): FieldLevel => grantFieldAccess(r, key) ?? 'none';

/**
 * Compare roles (ADR-0154): every permission in the catalogue against every role, built-in and custom,
 * then field access, then a preview of what a role is shown in the app. Labels come from the access
 * catalogue (GET /v1/roles/catalogue) and the roles from GET /v1/roles; nothing here changes access.
 */
export default function CompareRolesPage() {
  const t = useT();
  const inModule = React.useContext(ModuleFrameContext);
  const roles = useApi<Role[]>('/v1/roles');
  const catalogue = useApi<Catalogue>('/v1/roles/catalogue');
  const initialRole = useSearchParams().get('role');
  const [previewId, setPreviewId] = React.useState<string | null>(initialRole);
  const previewRef = React.useRef<HTMLDivElement>(null);

  const error = roles.error ?? catalogue.error;
  if (error)
    return (
      <EmptyState
        level={inModule ? 2 : 1}
        title={error.status === 403 ? t('errors.forbidden') : t('common.error')}
      />
    );
  const header = (
    <>
      <div>
        <PageTitle>{t('access.compare.title')}</PageTitle>
        <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
          {t('access.compare.intro')}
        </p>
      </div>
      <RolesNav />
    </>
  );
  if (!roles.data || !catalogue.data)
    return (
      <div className="flex flex-col gap-5">
        {header}
        <Skeleton className="h-96 w-full" />
      </div>
    );
  const list = roles.data;
  const preview = list.find((r) => r.id === previewId) ?? list.find((r) => r.key === 'employee') ?? list[0]!;
  const showPreview = (id: string) => {
    setPreviewId(id);
    // move to the preview, so keyboard and screen-reader users land on what changed
    requestAnimationFrame(() => previewRef.current?.focus());
  };

  return (
    <div className="flex flex-col gap-5">
      {header}
      <nav
        aria-label={t('access.compare.onThisPage')}
        className="flex flex-wrap gap-x-4 gap-y-1 text-callout"
      >
        <a href="#compare-permissions">{t('access.compare.permissionsTitle')}</a>
        <a href="#compare-fields">{t('access.compare.fieldsTitle')}</a>
        <a href="#compare-preview">{t('access.compare.previewTitle')}</a>
      </nav>
      <PermissionMatrix roles={list} catalogue={catalogue.data} onPreview={showPreview} />
      <FieldMatrix roles={list} catalogue={catalogue.data} />
      <div ref={previewRef} tabIndex={-1} id="compare-preview" className="scroll-mt-20 focus:outline-none">
        <PreviewAsRole roles={list} role={preview} onRole={setPreviewId} />
      </div>
    </div>
  );
}

/** The column header of one role: its name (a link to the role), type and admin badges, and a count. */
function RoleHeader({
  role,
  count,
  onPreview,
}: {
  role: Role;
  count?: string;
  onPreview?: (id: string) => void;
}) {
  const t = useT();
  const name = roleName(t, role);
  return (
    <span className="flex flex-col items-center gap-1 text-center">
      <Link href={`/app/settings/roles/${role.id}`} className="font-semibold">
        {name}
      </Link>
      <span className="flex flex-wrap justify-center gap-1">
        <Badge tone={role.builtIn ? 'neutral' : 'accent'}>
          {role.builtIn ? t('access.roles.builtIn') : t('access.roles.custom')}
        </Badge>
        {role.isAdmin ? <Badge tone="warning">{t('access.roles.admin')}</Badge> : null}
      </span>
      {count ? <span className="text-footnote font-normal text-text-secondary">{count}</span> : null}
      {onPreview ? (
        <button
          type="button"
          onClick={() => onPreview(role.id)}
          className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-footnote font-semibold text-accent hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
          aria-label={t('access.compare.previewNamed', { role: name })}
        >
          <Eye aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {t('access.compare.preview')}
        </button>
      ) : null}
    </span>
  );
}

/** ✓ or — with words for screen readers (the row and column headers name the permission and the role). */
function Mark({ on }: { on: boolean }) {
  const t = useT();
  return on ? (
    <>
      <Check aria-hidden className="mx-auto h-5 w-5 stroke-[2] text-success" />
      <span className="sr-only">{t('access.compare.has')}</span>
    </>
  ) : (
    <>
      <span aria-hidden className="text-text-secondary">
        —
      </span>
      <span className="sr-only">{t('access.compare.hasNot')}</span>
    </>
  );
}

const cell = 'border-b border-border px-3 py-2 align-middle';
const stickyCol = 'sticky left-0 z-10 bg-surface-raised';
const headCell = 'sticky top-0 z-20 border-b border-border bg-surface px-3 py-3 align-bottom font-normal';

/**
 * A comparison table that scrolls inside its own focusable region, header row and first column sticky.
 * The region is positioned so the cells' screen-reader text (absolutely positioned) scrolls with it
 * instead of widening the page.
 */
function MatrixRegion({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={label}
      className="relative max-h-[70vh] overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      {children}
    </div>
  );
}

function PermissionMatrix({
  roles,
  catalogue,
  onPreview,
}: {
  roles: Role[];
  catalogue: Catalogue;
  onPreview: (id: string) => void;
}) {
  const t = useT();
  const [area, setArea] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const [differences, setDifferences] = React.useState(false);
  const q = norm(query.trim());
  const areas = catalogue.areas
    .filter((a) => area === 'all' || a.area === area)
    .map((a) => ({
      ...a,
      permissions: a.permissions.filter((p) => {
        if (q && !norm(`${permissionLabel(t, p.key)} ${t(`access.area.${a.area}`)}`).includes(q))
          return false;
        if (differences) {
          const held = roles.filter((r) => holds(r, p.key)).length;
          if (held === 0 || held === roles.length) return false;
        }
        return true;
      }),
    }))
    .filter((a) => a.permissions.length);
  const shownKeys = areas.flatMap((a) => a.permissions.map((p) => p.key));
  const label = t('access.compare.permissionsTitle');
  return (
    <Card id="compare-permissions" className="scroll-mt-20 overflow-hidden p-0">
      <TableToolbar
        title={label}
        count={t('access.compare.permissionCount', { count: shownKeys.length })}
        search={
          <Input
            type="search"
            aria-label={t('access.compare.searchPermissions')}
            placeholder={t('access.compare.searchPermissions')}
            className="h-10 w-full sm:w-56"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
        filters={
          <>
            <select
              aria-label={t('access.compare.areaFilter')}
              className={cn(selectClass, 'w-auto max-w-full')}
              value={area}
              onChange={(e) => setArea(e.target.value)}
            >
              <option value="all">{t('access.compare.allAreas')}</option>
              {catalogue.areas.map((a) => (
                <option key={a.area} value={a.area}>
                  {t(`access.area.${a.area}`)}
                </option>
              ))}
            </select>
            <label className="flex min-h-10 items-center gap-2 text-callout">
              <input
                type="checkbox"
                className="h-5 w-5 accent-[var(--color-accent)]"
                checked={differences}
                onChange={(e) => setDifferences(e.target.checked)}
              />
              {t('access.compare.onlyDifferences')}
            </label>
          </>
        }
      />
      <p className="flex items-start gap-2 border-b border-border px-4 py-3 text-footnote text-text-secondary">
        <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 stroke-[1.5]" />
        <span>{t('access.compare.adminLegend')}</span>
      </p>
      {areas.length ? (
        <MatrixRegion label={label}>
          <table className="w-full border-separate border-spacing-0 text-left text-callout">
            <caption className="sr-only">{t('access.compare.permissionsCaption')}</caption>
            <thead>
              <tr>
                <th scope="col" className={cn(headCell, 'left-0 z-30 min-w-[200px] text-left font-semibold')}>
                  {t('access.compare.permission')}
                </th>
                {roles.map((r) => (
                  <th key={r.id} scope="col" className={cn(headCell, 'min-w-[132px]')}>
                    <RoleHeader
                      role={r}
                      onPreview={onPreview}
                      count={
                        r.permissions.includes('*')
                          ? t('access.roles.allPermissions')
                          : t('access.compare.heldCount', {
                              held: shownKeys.filter((k) => holds(r, k)).length,
                              count: shownKeys.length,
                            })
                      }
                    />
                  </th>
                ))}
              </tr>
            </thead>
            {areas.map((a) => (
              <tbody key={a.area}>
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={roles.length + 1}
                    className="border-b border-border bg-surface-raised px-3 pb-1 pt-4 text-left text-footnote font-semibold text-text-secondary"
                  >
                    <span className="sticky left-3">{t(`access.area.${a.area}`)}</span>
                  </th>
                </tr>
                {a.permissions.map((p) => (
                  <tr key={p.key} className="hover:bg-surface">
                    <th scope="row" className={cn(cell, stickyCol, 'font-normal')}>
                      <span className="flex flex-wrap items-center gap-2">
                        {permissionLabel(t, p.key)}
                        {p.admin ? (
                          <Badge tone="warning">
                            <ShieldCheck aria-hidden className="h-3 w-3 stroke-[1.5]" />
                            {t('access.compare.adminBadge')}
                          </Badge>
                        ) : null}
                      </span>
                    </th>
                    {roles.map((r) => (
                      <td key={r.id} className={cn(cell, 'text-center')}>
                        <Mark on={holds(r, p.key)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </MatrixRegion>
      ) : (
        <p role="status" className="px-4 py-6 text-callout text-text-secondary">
          {t('access.compare.noPermissionMatches')}
        </p>
      )}
    </Card>
  );
}

function FieldMatrix({ roles, catalogue }: { roles: Role[]; catalogue: Catalogue }) {
  const t = useT();
  const locale = useLocale();
  const [differences, setDifferences] = React.useState(false);
  type Row = { key: string; label: string; group?: boolean };
  const groups: Array<{ section: string | null; rows: Row[] }> = [
    { section: null, rows: [{ key: 'employee.*', label: t('access.editor.allFields'), group: true }] },
  ];
  for (const s of [...new Set(catalogue.fields.map((f) => f.section))]) {
    const rows: Row[] = catalogue.fieldGroups.includes(s)
      ? [{ key: `employee.${s}.*`, label: fieldLabel(t, `employee.${s}.*`), group: true }]
      : [];
    for (const f of catalogue.fields.filter((x) => x.section === s))
      rows.push({ key: `employee.${f.key}`, label: fieldLabel(t, `employee.${f.key}`) });
    groups.push({ section: s, rows });
  }
  if (catalogue.customFields.length)
    groups.push({
      section: 'custom',
      rows: catalogue.customFields.map((c) => ({
        key: `employee.custom.${c.key}`,
        label: fieldLabel(t, `employee.custom.${c.key}`, catalogue.customFields, locale),
      })),
    });
  const differs = (k: string) => new Set(roles.map((r) => levelOf(r, k))).size > 1;
  const shown = groups
    .map((g) => ({ ...g, rows: differences ? g.rows.filter((r) => differs(r.key)) : g.rows }))
    .filter((g) => g.rows.length);
  const label = t('access.compare.fieldsTitle');
  return (
    <Card id="compare-fields" className="scroll-mt-20 overflow-hidden p-0">
      <TableToolbar
        title={label}
        count={t('access.compare.fieldCount', { count: shown.reduce((n, g) => n + g.rows.length, 0) })}
        filters={
          <label className="flex min-h-10 items-center gap-2 text-callout">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--color-accent)]"
              checked={differences}
              onChange={(e) => setDifferences(e.target.checked)}
            />
            {t('access.compare.onlyDifferences')}
          </label>
        }
      />
      <p className="border-b border-border px-4 py-3 text-footnote text-text-secondary">
        {t('access.compare.fieldsBody')}
      </p>
      <MatrixRegion label={label}>
        <table className="w-full border-separate border-spacing-0 text-left text-callout">
          <caption className="sr-only">{t('access.compare.fieldsCaption')}</caption>
          <thead>
            <tr>
              <th scope="col" className={cn(headCell, 'left-0 z-30 min-w-[200px] text-left font-semibold')}>
                {t('access.editor.fieldCol')}
              </th>
              {roles.map((r) => (
                <th key={r.id} scope="col" className={cn(headCell, 'min-w-[132px]')}>
                  <RoleHeader role={r} />
                </th>
              ))}
            </tr>
          </thead>
          {shown.map((g) => (
            <tbody key={g.section ?? 'all'}>
              {g.section ? (
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={roles.length + 1}
                    className="border-b border-border bg-surface-raised px-3 pb-1 pt-4 text-left text-footnote font-semibold text-text-secondary"
                  >
                    <span className="sticky left-3">{t(`access.section.${g.section}`)}</span>
                  </th>
                </tr>
              ) : null}
              {g.rows.map((row) => (
                <tr key={row.key} className="hover:bg-surface">
                  <th
                    scope="row"
                    className={cn(cell, stickyCol, row.group ? 'font-semibold' : 'font-normal')}
                  >
                    {row.label}
                  </th>
                  {roles.map((r) => {
                    const level = levelOf(r, row.key);
                    return (
                      <td
                        key={r.id}
                        className={cn(
                          cell,
                          'text-center',
                          level === 'none' ? 'text-text-secondary' : 'font-semibold text-text',
                        )}
                      >
                        {t(`access.editor.level.${level}`)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </MatrixRegion>
    </Card>
  );
}

/** Rail order: Home, the groups, then Help. */
const ORDER = ['home', ...GROUPS];

function PreviewAsRole({ roles, role, onRole }: { roles: Role[]; role: Role; onRole: (id: string) => void }) {
  const t = useT();
  const [employee, setEmployee] = React.useState(true);
  // Ask HR is listed when the role may ask; whether the workspace has it switched on is a separate setting
  const p = rolePreview(role.permissions, {
    employee,
    askHr: role.permissions.some((g) => actionMatches(g, 'ai.ask')),
  });
  const defaultScope = role.builtIn
    ? BUILT_IN_ROLES.find((b) => b.key === role.key)?.defaultScope
    : undefined;
  const name = roleName(t, role);
  const moduleName = (m: WorkspaceModule) => t(m.label);
  return (
    <Card className="flex flex-col gap-5">
      <div>
        <CardTitle>{t('access.compare.previewTitle')}</CardTitle>
        <p className="mt-1 max-w-[var(--prose-width)] text-callout text-text-secondary">
          {t('access.compare.previewIntro')}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field id="preview-role" label={t('access.compare.previewRole')} className="w-full sm:w-72">
          {(a) => (
            <select {...a} className={selectClass} value={role.id} onChange={(e) => onRole(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleName(t, r)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="flex min-h-10 items-center gap-2 text-callout">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[var(--color-accent)]"
            checked={employee}
            onChange={(e) => setEmployee(e.target.checked)}
          />
          {t('access.compare.hasEmployeeRecord')}
        </label>
      </div>
      <div className="flex items-start gap-3 rounded-md bg-accent-subtle p-4 text-callout text-text">
        <Info aria-hidden className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5]" />
        <div className="flex flex-col gap-1">
          <p>{t('access.compare.scopeNote')}</p>
          {defaultScope ? (
            <p className="text-footnote">
              {t('access.compare.defaultScope', { role: name, scope: t(`access.scope.${defaultScope}`) })}
            </p>
          ) : null}
        </div>
      </div>
      <p role="status" className="text-callout font-semibold">
        {t('access.compare.previewSummary', {
          role: name,
          modules: t('access.compare.moduleCount', { count: p.modules.length }),
          actions: t('access.compare.actionCount', { count: p.actions.length }),
          sections: t('access.compare.sectionCount', { count: p.sections.length }),
        })}
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        <section
          aria-labelledby="pv-modules"
          className="flex flex-col gap-3 border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0 lg:first:border-l-0 lg:first:pl-0"
        >
          <h3 id="pv-modules" className="text-callout font-semibold">
            {t('access.compare.modulesTitle')}
          </h3>
          {ORDER.map((g) => {
            const items = p.modules.filter((m) => m.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="flex flex-col gap-1">
                {g !== 'home' ? (
                  <p className="text-footnote font-semibold text-text-secondary">{t(`app.ws.group.${g}`)}</p>
                ) : null}
                <ul className="flex flex-col gap-2">
                  {items.map((m) => {
                    const Icon = m.icon;
                    return (
                      <li key={m.key} className="flex items-start gap-2">
                        <Icon
                          aria-hidden
                          className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5] text-text-secondary"
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="text-callout font-semibold">{moduleName(m)}</span>
                          {m.tabs.length > 1 || m.tabs[0]?.label !== m.label ? (
                            <span className="text-footnote text-text-secondary">
                              {m.tabs.map((tab) => t(tab.label)).join(' · ')}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          <NotShown
            items={[
              ...p.hiddenModules.map((m) => moduleName(m)),
              ...p.hiddenTabs.map((h) =>
                t('access.compare.hiddenTabs', {
                  module: moduleName(h.module),
                  tabs: h.tabs.map((tab) => t(tab.label)).join(', '),
                }),
              ),
            ]}
          />
        </section>
        <section
          aria-labelledby="pv-actions"
          className="flex flex-col gap-3 border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0 lg:first:border-l-0 lg:first:pl-0"
        >
          <h3 id="pv-actions" className="text-callout font-semibold">
            {t('access.compare.actionsTitle')}
          </h3>
          {p.actions.length ? (
            <ul className="flex flex-wrap gap-2">
              {p.actions.map((a) => {
                const Icon = a.icon;
                return (
                  <li
                    key={a.key}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1 text-footnote"
                  >
                    <Icon aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t(a.label)}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-callout text-text-secondary">{t('access.compare.none')}</p>
          )}
          <NotShown items={p.hiddenActions.map((a) => t(a.label))} />
        </section>
        <section
          aria-labelledby="pv-settings"
          className="flex flex-col gap-3 border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0 lg:first:border-l-0 lg:first:pl-0"
        >
          <h3 id="pv-settings" className="text-callout font-semibold">
            {t('access.compare.settingsTitle')}
          </h3>
          {p.sections.length ? (
            SETTINGS_GROUPS.map((g) => {
              const items = p.sections.filter((s) => s.group === g);
              if (!items.length) return null;
              return (
                <div key={g} className="flex flex-col gap-1">
                  <p className="text-footnote font-semibold text-text-secondary">
                    {t(`admin.group.${g}.title`)}
                  </p>
                  <ul className="flex flex-col gap-1 text-callout">
                    {items.map((s) => (
                      <li key={s.key}>{t(`${sectionMessages(s)}.title`)}</li>
                    ))}
                  </ul>
                </div>
              );
            })
          ) : (
            <p className="text-callout text-text-secondary">{t('access.compare.noSettings')}</p>
          )}
          <NotShown items={p.hiddenSections.map((s) => t(`${sectionMessages(s)}.title`))} />
        </section>
      </div>
      <p className="text-footnote text-text-secondary">{t('access.compare.previewFoot')}</p>
    </Card>
  );
}

/** What the role is not shown, so the gating is visible both ways. */
function NotShown({ items }: { items: string[] }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <div className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
      <h4 className="text-footnote font-semibold text-text-secondary">{t('access.compare.notShown')}</h4>
      <ul className="flex flex-col gap-0.5 text-footnote text-text-secondary">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}
