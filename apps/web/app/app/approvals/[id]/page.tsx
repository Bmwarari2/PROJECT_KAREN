'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { ArrowRight, Check, ClipboardCheck, X } from 'lucide-react';
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  CardTitle,
  EmptyState,
  Field,
  ListItem,
  ListSection,
  Skeleton,
  Textarea,
  useToast,
} from '@thapsus/ui';
import { formatDateTime } from '@thapsus/core/i18n';
import { api, ApiProblem } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { viewerZone } from '@/lib/week';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { DetailList } from '@/components/detail-list';
import { IntentLink } from '@/components/intent-link';
import { PersonLink } from '@/components/person-link';
import { useSectionLevel } from '@/components/module-page';
import { PageTitle, useSession } from '../../shell';
import { useApprovalDetails } from '../details';

interface ApprovalDetail {
  id: string;
  subject: string;
  status: string;
  policy: string;
  subjectEmployeeId: string | null;
  subjectName: string | null;
  requestedAt: string;
  decidedAt: string | null;
  currentStep: number;
  payload: Record<string, unknown>;
  requestedBy: { userId: string; name: string } | null;
  steps: Array<{
    index: number;
    status: string;
    approvers: string[];
    decidedByName: string | null;
    decidedAt: string | null;
    comment: string | null;
    dueAt: string | null;
  }>;
  related: { type: string; id: string; href: string } | null;
  canDecide: boolean;
}

const tone = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
} as const;

/**
 * One approval request (ADR-0160): what is asked, for whom, by whom, each step of the chain and the
 * record it is about; its approver decides here, with an optional comment.
 */
export default function ApprovalPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const session = useSession();
  const sec = useSectionLevel();
  const zone = viewerZone(session?.timeZone);
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<ApprovalDetail>(`/v1/approvals/${id}`);
  const describe = useApprovalDetails();
  const [comment, setComment] = React.useState('');
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null);
  const crumbs = [{ label: t('approvals.title'), href: '/app/approvals' }];

  if (error)
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={[...crumbs, { label: t('actionable.approval.title') }]} />
        <EmptyState
          icon={<ClipboardCheck aria-hidden />}
          title={error.status === 403 ? t('errors.forbidden') : t('errors.notFound')}
        />
      </div>
    );
  if (!data) return <Skeleton className="h-64 w-full" />;
  const when = (v: string) => formatDateTime(v, locale, zone);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision);
    try {
      await api(`/v1/approvals/${id}/decide`, {
        method: 'POST',
        json: { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) },
      });
      toast({
        title: t(decision === 'approve' ? 'actionable.approval.approved' : 'actionable.approval.declined'),
        tone: 'success',
      });
      setComment('');
      reload();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  }

  const facts = [
    {
      key: 'person',
      label: t('approvals.col.person'),
      value: data.subjectName ? <PersonLink id={data.subjectEmployeeId} name={data.subjectName} /> : '—',
    },
    {
      key: 'requestedBy',
      label: t('actionable.approval.requestedBy'),
      value: data.requestedBy?.name ?? t('actionable.approval.system'),
    },
    { key: 'requested', label: t('approvals.col.requested'), value: when(data.requestedAt) },
    ...(data.decidedAt
      ? [{ key: 'decided', label: t('actionable.approval.decidedOn'), value: when(data.decidedAt) }]
      : []),
    ...describe(data.payload),
  ];
  const reason = typeof data.payload.reason === 'string' ? data.payload.reason : null;

  return (
    <div className="flex max-w-[var(--prose-width)] flex-col gap-4" data-testid="approval-detail">
      <Breadcrumbs
        items={[
          ...crumbs,
          { label: data.subjectName ? `${data.policy} · ${data.subjectName}` : data.policy },
        ]}
      />
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto flex min-w-0 flex-col gap-2">
            <PageTitle className="text-title-2 break-words">{data.policy}</PageTitle>
            <div>
              <Badge tone={tone[data.status as keyof typeof tone] ?? 'neutral'}>
                {t(`actionable.approval.status.${data.status}`)}
              </Badge>
            </div>
          </div>
          {data.related ? (
            <IntentLink
              href={data.related.href}
              className={`${buttonVariants({ variant: 'secondary', size: 'md' })} no-underline`}
            >
              {t(`actionable.approval.related.${data.related.type}`)}
              <ArrowRight aria-hidden className="h-4 w-4 stroke-[1.5]" />
            </IntentLink>
          ) : null}
        </div>
        <DetailList items={facts} />
        {reason ? (
          <p className="text-callout text-text-secondary">
            <span className="font-semibold text-text">{t('actionable.approval.reason')}: </span>
            {reason}
          </p>
        ) : null}
      </Card>

      {data.canDecide ? (
        <Card className="flex flex-col gap-3" data-testid="approval-decide">
          <CardTitle as={sec.heading}>{t('actionable.approval.decideTitle')}</CardTitle>
          <Field
            id="approval-comment"
            label={t('actionable.approval.comment')}
            hint={t('actionable.approval.commentHint')}
          >
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                maxLength={1000}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button loading={busy === 'approve'} disabled={!!busy} onClick={() => decide('approve')}>
              <Check aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('common.approve')}
            </Button>
            <Button
              variant="secondary"
              loading={busy === 'reject'}
              disabled={!!busy}
              onClick={() => decide('reject')}
            >
              <X aria-hidden className="h-4 w-4 stroke-[1.5]" />
              {t('actionable.approval.decline')}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* the chain as grouped rows (ADR-0180): one row per step, its status at the end */}
      <ListSection title={t('actionable.approval.steps')} headingLevel={sec.level}>
        {data.steps.map((s) => (
          <ListItem
            key={s.index}
            title={t('actionable.approval.step', { n: s.index + 1 })}
            subtitle={
              <>
                <span className="block">
                  {t('actionable.approval.approvers', { names: s.approvers.join(', ') || '—' })}
                </span>
                {s.comment ? <span className="mt-1 block text-text">{s.comment}</span> : null}
              </>
            }
            meta={
              s.decidedAt
                ? t('actionable.approval.decidedBy', {
                    name: s.decidedByName ?? '—',
                    date: when(s.decidedAt),
                  })
                : undefined
            }
            accessory={
              <Badge tone={tone[s.status as keyof typeof tone] ?? 'neutral'}>
                {t(`actionable.approval.status.${s.status}`)}
              </Badge>
            }
          />
        ))}
      </ListSection>
    </div>
  );
}
