'use client';
import { Download } from 'lucide-react';
import { buttonVariants } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { useSession } from '@/app/app/shell';

/**
 * CSV and Excel download links for a list view (`/v1/exports/<list>`). The export holds exactly the
 * rows the list shows the caller, with field-level permissions applied; shown only with exports.run.
 */
export function ExportLinks({ list, params = {} }: { list: 'employees' | 'tasks' | 'approvals' | 'documents'; params?: Record<string, string | undefined> }) {
  const t = useT();
  const session = useSession();
  const allowed = session?.permissions.some((p) => p === '*' || p === 'exports.*' || p === 'exports.run');
  if (!allowed) return null;
  const href = (format: 'csv' | 'xlsx') => {
    const q = new URLSearchParams({ format });
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return `/v1/exports/${list}?${q}`;
  };
  return (
    <>
      {(['csv', 'xlsx'] as const).map((format) => (
        <a key={format} href={href(format)} download className={buttonVariants({ variant: 'secondary', size: 'sm' }) + ' no-underline'}>
          <Download aria-hidden className="h-4 w-4 stroke-[1.5]" />
          {format === 'csv' ? t('common.exportCsv') : t('common.exportExcel')}
        </a>
      ))}
    </>
  );
}
