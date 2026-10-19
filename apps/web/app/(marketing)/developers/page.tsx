import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, Section } from '@thapsus/ui';
import { API_SCOPE_KEYS, API_SCOPES, apiClientMayCall } from '@thapsus/core/api-scopes';
import spec from '@thapsus/sdk/openapi.json';
import { serverContext } from '@/lib/server';

/**
 * Public API reference built from the published OpenAPI 3.1 document (packages/sdk/openapi.json).
 * Rendered on the server per request like every page, so its framework scripts carry the CSP nonce
 * (ADR-0130): no third-party script, and the raw spec stays downloadable at /openapi.json.
 */

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverContext();
  return { title: t('developers.title'), description: t('developers.lead') };
}

interface Operation {
  method: string;
  path: string;
  summary?: string;
  deprecated?: boolean;
  parameters: Array<{ name: string; in: string; required?: boolean }>;
  hasBody: boolean;
  responses: string[];
}
type SpecOp = { tags?: string[]; summary?: string; deprecated?: boolean; parameters?: Array<{ name: string; in: string; required?: boolean }>; requestBody?: unknown; responses?: Record<string, unknown> };

const HIDDEN_TAGS = new Set(['backoffice', 'global']);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function groups(): Array<[string, Operation[]]> {
  const byTag = new Map<string, Operation[]>();
  for (const [path, item] of Object.entries((spec as unknown as { paths: Record<string, Record<string, SpecOp>> }).paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const tag = op.tags?.[0] ?? 'other';
      if (HIDDEN_TAGS.has(tag) || path.includes('/internal/')) continue;
      const list = byTag.get(tag) ?? [];
      list.push({ method, path, summary: op.summary, deprecated: op.deprecated, parameters: op.parameters ?? [], hasBody: !!op.requestBody, responses: Object.keys(op.responses ?? {}) });
      byTag.set(tag, list);
    }
  }
  return [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const GUIDE = ['authentication', 'scopes', 'pagination', 'idempotency', 'rateLimits', 'webhooks', 'versioning', 'residency'] as const;

export default async function DevelopersPage() {
  const { t } = await serverContext();
  const all = groups();
  const version = (spec as unknown as { info: { version: string } }).info.version;
  return (
    <>
      <Section tone="bg" className="pt-16" labelledBy="dev-title">
        <Badge tone="accent">{t('developers.eyebrow', { version })}</Badge>
        <h1 id="dev-title" className="mt-4 text-title-1">
          {t('developers.title')}
        </h1>
        <p className="mt-4 max-w-[var(--prose-width)] text-body-lg text-text-secondary">{t('developers.lead')}</p>
        <p className="mt-4 text-callout">
          <a href="/openapi.json">{t('developers.download')}</a>
        </p>
      </Section>

      <Section tone="surface" labelledBy="guide-title">
        <h2 id="guide-title" className="text-title-2">
          {t('developers.guideTitle')}
        </h2>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {GUIDE.map((g) => (
            <Card key={g} id={g}>
              <h3 className="text-title-3">{t(`developers.guide.${g}.title`)}</h3>
              <p className="mt-2 text-callout text-text-secondary">{t(`developers.guide.${g}.body`)}</p>
            </Card>
          ))}
        </div>
        <h3 className="mt-10 text-title-3">{t('developers.scopesTitle')}</h3>
        <ul className="mt-3 grid gap-2 text-callout md:grid-cols-2">
          {API_SCOPE_KEYS.map((s) => (
            <li key={s}>
              <code className="text-footnote">{s}</code> {t(`platform.scopes.${s.replace(':', '_')}`)}
              <span className="block text-footnote text-text-secondary">{API_SCOPES[s].join(', ')}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section tone="bg" labelledBy="ref-title">
        <h2 id="ref-title" className="text-title-2">
          {t('developers.referenceTitle')}
        </h2>
        <p className="mt-2 max-w-[var(--prose-width)] text-callout text-text-secondary">{t('developers.referenceLead')}</p>
        <div className="mt-6 flex flex-col gap-3">
          {all.map(([tag, ops]) => (
            <details key={tag} className="rounded-lg bg-surface-raised p-4 shadow-sm">
              <summary className="cursor-pointer text-callout font-semibold">
                {t('developers.tag', { tag, count: ops.length })}
              </summary>
              <ul className="mt-3 flex flex-col divide-y divide-border">
                {ops.map((o) => (
                  <li key={`${o.method} ${o.path}`} className="py-3">
                    <p className="flex flex-wrap items-center gap-2">
                      <Badge tone="accent" className="uppercase">
                        {o.method}
                      </Badge>
                      <code className="break-all text-footnote">{o.path}</code>
                      {apiClientMayCall(o.path.replace(/\{(\w+)\}/g, ':$1')) || o.path === '/v1/oauth/token' ? <Badge tone="success">{t('developers.apiClients')}</Badge> : null}
                      {o.deprecated ? <Badge tone="warning">{t('developers.deprecated')}</Badge> : null}
                    </p>
                    {o.summary ? <p className="mt-1 text-footnote text-text-secondary">{o.summary}</p> : null}
                    <p className="mt-1 text-footnote text-text-secondary">
                      {t('developers.params', { params: o.parameters.map((p) => `${p.name}${p.required ? '*' : ''} (${p.in})`).join(', ') || t('common.none') })}
                      {o.hasBody ? ` · ${t('developers.body')}` : ''}
                      {` · ${t('developers.responses', { codes: o.responses.join(', ') })}`}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
        <p className="mt-8 text-callout">
          <Link href="/signup">{t('developers.cta')}</Link>
        </p>
      </Section>
    </>
  );
}
