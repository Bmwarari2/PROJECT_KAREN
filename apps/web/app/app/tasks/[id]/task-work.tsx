'use client';
import * as React from 'react';
import { ArrowRight, CheckCircle2, CircleDot, MessageSquareReply } from 'lucide-react';
import { Button, buttonVariants, cn } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import { IntentLink } from '@/components/intent-link';
import { MarkDoneDialog } from './mark-done-dialog';
import type { TaskDetail } from './types';

const TONE: Record<string, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  accent: 'text-accent',
  neutral: 'text-text-secondary',
};

/**
 * Where the task's work is done (ADR-0191): the main button opens it with the person already chosen,
 * the live status of the linked record says how far it has got, and Mark as done stays as the fallback,
 * with a note. Kept apart from the page so permission gating of each control stays in one place.
 */
export function TaskWork({ data, onChanged }: { data: TaskDetail; onChanged: () => void }) {
  const t = useT();
  const [marking, setMarking] = React.useState(false);
  const open = data.status === 'open';
  const isRequest = data.source === 'hr_request';
  const main = open && data.action && !isRequest ? data.action : null;
  const fallback = open && data.canComplete;
  if (!main && !fallback && !data.recordStatus) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="task-work">
      {main || fallback ? (
        <div className="flex flex-wrap items-center gap-2">
          {main ? (
            <IntentLink
              href={main.href}
              className={`${buttonVariants({ variant: 'primary', size: 'md' })} no-underline`}
              data-testid="task-main-action"
            >
              {main.label}
              <ArrowRight aria-hidden className="h-4 w-4 stroke-[1.5]" />
            </IntentLink>
          ) : null}
          {fallback ? (
            <Button
              variant={main ? 'secondary' : 'primary'}
              onClick={() => setMarking(true)}
              data-testid="task-mark-done"
            >
              {isRequest ? (
                <MessageSquareReply aria-hidden className="h-4 w-4 stroke-[1.5]" />
              ) : (
                <CheckCircle2 aria-hidden className="h-4 w-4 stroke-[1.5]" />
              )}
              {isRequest
                ? t('taskActions.page.reply.button')
                : main
                  ? t('taskActions.page.fallback')
                  : t('actionable.task.markDone')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {data.recordStatus ? (
        <p className="flex items-start gap-2 text-callout" data-testid="task-record-status">
          <CircleDot
            aria-hidden
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 stroke-[1.5]',
              TONE[data.recordStatus.tone] ?? TONE.neutral,
            )}
          />
          <span>
            <span className="sr-only">{t('taskActions.page.statusPrefix')} </span>
            {data.recordStatus.text}
          </span>
        </p>
      ) : null}
      {open && data.closesItself ? (
        <p className="text-footnote text-text-secondary">{t('taskActions.page.closesItself')}</p>
      ) : null}
      {fallback ? (
        <MarkDoneDialog
          taskId={data.id}
          open={marking}
          onOpenChange={setMarking}
          onDone={onChanged}
          reply={isRequest ? { name: data.subject?.name ?? '' } : undefined}
        />
      ) : null}
    </div>
  );
}
