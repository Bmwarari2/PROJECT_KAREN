'use client';
import * as React from 'react';
import { Button, Dialog, DialogContent, Field, Textarea, useToast } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

/**
 * Mark as done by hand (ADR-0191): the fallback when the work was done another way. It asks for a short
 * note, which is kept with the task and in the audit trail. For a request to HR the note is the reply
 * the person who asked sees.
 */
export function MarkDoneDialog({
  taskId,
  open,
  onOpenChange,
  onDone,
  reply,
}: {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  /** A request to HR: the note is a reply to this person. */
  reply?: { name: string };
}) {
  const t = useT();
  const toast = useToast();
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const text = (key: string, vars?: Record<string, string>) =>
    t(`taskActions.page.${reply ? 'reply' : 'note'}.${key}`, vars);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    try {
      await api(`/v1/tasks/${taskId}/complete`, { method: 'POST', json: { note: note.trim() } });
      toast({ title: t('actionable.task.completed'), tone: 'success' });
      onOpenChange(false);
      setNote('');
      onDone();
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={text('title', { name: reply?.name ?? '' })}
        description={text('body')}
        closeLabel={t('common.close')}
      >
        <form onSubmit={submit} className="flex flex-col gap-4" data-testid="mark-done-form">
          <Field
            id="task-done-note"
            label={text('label')}
            hint={reply ? undefined : t('taskActions.page.note.hint')}
          >
            {(p) => (
              <Textarea
                {...p}
                required
                maxLength={500}
                rows={4}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={busy} disabled={!note.trim()}>
              {text('submit')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
