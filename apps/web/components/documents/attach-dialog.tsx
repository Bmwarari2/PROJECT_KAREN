'use client';
import * as React from 'react';
import { FileUp, Paperclip, X } from 'lucide-react';
import { Button, Dialog, DialogContent, Field, Input, Textarea, useToast } from '@thapsus/ui';
import { useLocale, useT } from '@/lib/i18n-client';
import { byteSize } from './labels';

export const ATTACHMENT_TYPES = [
  'right_to_work',
  'driving_licence',
  'contract',
  'qualification',
  'background_check',
  'other',
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];
const EVIDENCE_TYPES = ['passport', 'brp_evisa', 'share_code_result', 'birth_certificate', 'other'] as const;
const selectClass =
  'h-11 w-full rounded-sm border border-border-strong bg-surface-raised px-2 text-callout text-text focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60';
/** The API's limit (ADR-0165); checked here first so nobody waits for a refusal. */
const MAX_BYTES = 20 * 1024 * 1024;
const IMAGES_AND_PDF = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp';
const WITH_WORD = `${IMAGES_AND_PDF},.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document`;
/** Who sees a new attachment unless HR chooses otherwise: evidence and checks stay with HR. */
const DEFAULT_VISIBILITY: Record<AttachmentType, 'hr' | 'employee'> = {
  right_to_work: 'hr',
  driving_licence: 'employee',
  contract: 'employee',
  qualification: 'employee',
  background_check: 'hr',
  other: 'hr',
};

export interface AttachedDoc {
  id: string;
  title: string;
}

/**
 * HR attaches a document to a person (ADR-0165): the type, dates, a note and who can see it, then one file by
 * drag and drop or the file button, with upload progress. The idea of the drop zone follows EasyUI's
 * `animated-file-upload` (MIT, © 2026 Suraj Maurya; reference only, rebuilt from our tokens without its motion
 * library). The file input stays a real, visible input, so keyboards and screen readers use it as usual.
 */
export function AttachDialog({
  employeeId,
  employeeName,
  open,
  onOpenChange,
  preset,
  onAttached,
}: {
  employeeId: string;
  employeeName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: { attachmentType?: AttachmentType; rtwCheckId?: string | null };
  onAttached: (doc: AttachedDoc) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const initial = preset?.attachmentType ?? 'driving_licence';
  const [type, setType] = React.useState<AttachmentType>(initial);
  const [evidence, setEvidence] = React.useState<(typeof EVIDENCE_TYPES)[number]>('passport');
  const [title, setTitle] = React.useState('');
  const [issuedOn, setIssuedOn] = React.useState('');
  const [expiresOn, setExpiresOn] = React.useState('');
  const [note, setNote] = React.useState('');
  const [visibility, setVisibility] = React.useState<'hr' | 'employee'>(DEFAULT_VISIBILITY[initial]);
  const [file, setFile] = React.useState<File | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rtw = type === 'right_to_work';
  const maxLabel = byteSize(MAX_BYTES, locale);

  React.useEffect(() => {
    if (!open) return;
    const ty = preset?.attachmentType ?? 'driving_licence';
    setType(ty);
    setVisibility(DEFAULT_VISIBILITY[ty]);
    setFile(null);
    setProgress(null);
    setProblem(null);
    setTitle('');
    setIssuedOn('');
    setExpiresOn('');
    setNote('');
  }, [open, preset?.attachmentType]);

  const choose = (f: File | null | undefined) => {
    setProblem(null);
    if (!f) return setFile(null);
    if (f.size > MAX_BYTES) {
      setFile(null);
      return setProblem(t('docAttach.tooLarge', { size: maxLabel }));
    }
    setFile(f);
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setProblem(t('docAttach.noFile'));
    const body = new FormData();
    body.set('attachmentType', type);
    body.set('visibility', visibility);
    if (rtw) body.set('evidenceType', evidence);
    if (rtw && preset?.rtwCheckId) body.set('rtwCheckId', preset.rtwCheckId);
    if (!rtw && title.trim()) body.set('title', title.trim());
    if (issuedOn) body.set('issuedOn', issuedOn);
    if (expiresOn) body.set('expiresOn', expiresOn);
    if (note.trim()) body.set('note', note.trim());
    body.set('file', file, file.name);
    // XMLHttpRequest, not fetch: it reports upload progress
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/v1/employees/${employeeId}/documents`);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(xhr.responseText || '{}');
      } catch {
        // not JSON: handled as a failure below
      }
      setProgress(null);
      if (xhr.status === 201) {
        toast({ title: t('docAttach.attached', { title: String(json.title ?? '') }), tone: 'success' });
        onAttached({ id: String(json.id), title: String(json.title ?? '') });
        onOpenChange(false);
      } else setProblem(String(json.detail ?? json.title ?? t('docAttach.failed')));
    };
    xhr.onerror = () => {
      setProgress(null);
      setProblem(t('docAttach.failed'));
    };
    setProgress(0);
    xhr.send(body);
  }

  const busy = progress !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      {open ? (
        <DialogContent
          title={t('docAttach.dialogTitle', { name: employeeName })}
          description={t('docAttach.dialogBody')}
          closeLabel={t('common.close')}
        >
          <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
            <Field id="attach-type" label={t('docAttach.typeLabel')}>
              {(p) => (
                <select
                  {...p}
                  className={selectClass}
                  value={type}
                  disabled={!!preset?.attachmentType}
                  onChange={(e) => {
                    const ty = e.target.value as AttachmentType;
                    setType(ty);
                    setVisibility(DEFAULT_VISIBILITY[ty]);
                  }}
                >
                  {ATTACHMENT_TYPES.map((a) => (
                    <option key={a} value={a}>
                      {t(`docAttach.type.${a}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {rtw ? (
              <>
                <Field
                  id="attach-evidence"
                  label={t('docAttach.evidenceType')}
                  hint={t('docAttach.vaultHint')}
                >
                  {(p) => (
                    <select
                      {...p}
                      className={selectClass}
                      value={evidence}
                      onChange={(e) => setEvidence(e.target.value as (typeof EVIDENCE_TYPES)[number])}
                    >
                      {EVIDENCE_TYPES.map((v) => (
                        <option key={v} value={v}>
                          {t(`docAttach.evidence.${v}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </>
            ) : (
              <Field id="attach-title" label={t('docAttach.title')} hint={t('docAttach.titleHint')}>
                {(p) => (
                  <Input {...p} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
                )}
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="attach-issued" label={t('docAttach.issuedOn')}>
                {(p) => (
                  <Input {...p} type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
                )}
              </Field>
              <Field id="attach-expires" label={t('docAttach.expiresOn')} hint={t('docAttach.expiresHint')}>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    min={issuedOn || undefined}
                    value={expiresOn}
                    onChange={(e) => setExpiresOn(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Field id="attach-note" label={t('docAttach.note')} hint={t('docAttach.noteHint')}>
              {(p) => (
                <Textarea
                  {...p}
                  rows={2}
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-callout font-semibold">{t('docAttach.visibility')}</legend>
              {(['hr', 'employee'] as const).map((v) => (
                <label key={v} className="flex min-h-11 items-center gap-3 text-callout">
                  <input
                    type="radio"
                    name="attach-visibility"
                    value={v}
                    checked={visibility === v}
                    onChange={() => setVisibility(v)}
                    className="h-5 w-5 accent-[var(--color-accent)]"
                  />
                  {v === 'hr'
                    ? t('docAttach.visibilityHr')
                    : t('docAttach.visibilityEmployee', { name: employeeName })}
                </label>
              ))}
            </fieldset>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                choose(e.dataTransfer.files[0]);
              }}
              className={`flex flex-col items-start gap-3 rounded-lg border-2 border-dashed p-4 transition-colors duration-[var(--duration-fast)] motion-reduce:transition-none ${
                dragging ? 'border-accent bg-accent-subtle' : 'border-border-strong'
              }`}
            >
              <p className="flex items-center gap-2 text-callout text-text">
                <FileUp aria-hidden className="h-5 w-5 shrink-0 stroke-[1.5] text-accent" />
                {t('docAttach.drop')}
              </p>
              <label htmlFor="attach-file" className="text-footnote text-text-secondary">
                {t('docAttach.fileLabel')}
              </label>
              <input
                ref={inputRef}
                id="attach-file"
                type="file"
                accept={
                  type === 'right_to_work' || type === 'driving_licence' || type === 'background_check'
                    ? IMAGES_AND_PDF
                    : WITH_WORD
                }
                aria-describedby="attach-file-hint"
                onChange={(e) => choose(e.target.files?.[0])}
                className="w-full text-callout text-text-secondary file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-pill file:border file:border-border file:bg-surface-raised file:px-4 file:text-callout file:font-semibold file:text-text"
              />
              <p id="attach-file-hint" className="text-footnote text-text-secondary">
                {rtw || type === 'driving_licence' || type === 'background_check'
                  ? t('docAttach.acceptedImages', { size: maxLabel })
                  : t('docAttach.acceptedWord', { size: maxLabel })}
              </p>
              {file ? (
                <p className="flex w-full min-w-0 items-center gap-2 text-callout">
                  <Paperclip aria-hidden className="h-4 w-4 shrink-0 stroke-[1.5]" />
                  <span className="min-w-0 flex-1 break-words">
                    {t('docAttach.selected', { name: file.name, size: byteSize(file.size, locale) })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label={t('docAttach.remove')}
                    onClick={() => {
                      setFile(null);
                      if (inputRef.current) inputRef.current.value = '';
                    }}
                  >
                    <X aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  </Button>
                </p>
              ) : null}
            </div>
            {busy ? (
              <div className="flex flex-col gap-1">
                <progress
                  max={100}
                  value={progress ?? 0}
                  aria-label={t('docAttach.progressLabel')}
                  className="h-2 w-full accent-[var(--color-accent)]"
                />
                <p className="text-footnote text-text-secondary" role="status">
                  {t('docAttach.uploading', { percent: progress ?? 0 })}
                </p>
              </div>
            ) : null}
            {problem ? (
              <p className="text-callout text-danger" role="alert">
                {problem}
              </p>
            ) : null}
            <Button type="submit" className="min-h-11 self-start" loading={busy}>
              {t('docAttach.save')}
            </Button>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
