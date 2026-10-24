'use client';
import { useParams } from 'next/navigation';
import { EmptyState, Skeleton } from '@thapsus/ui';
import { FileText } from 'lucide-react';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { TemplateEditor, type TemplateDetail } from '../editor';

/** One document template: edit (a new version), archive or restore, and its versions (16.9). */
export default function TemplatePage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<TemplateDetail>(`/v1/document-templates/${id}`);
  if (error) return <EmptyState level={2} icon={<FileText aria-hidden />} title={t('docTpl.notFound')} />;
  if (!data) return <Skeleton className="h-96 w-full" />;
  return <TemplateEditor key={`${data.id}:${data.version}:${data.status}`} initial={data} onSaved={reload} />;
}
