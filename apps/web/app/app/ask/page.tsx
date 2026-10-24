'use client';
import * as React from 'react';
import Link from 'next/link';
import { Bot, BotOff, FileText, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Skeleton, Textarea, useToast } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';
import { useApi } from '@/lib/use-api';
import { PageIntro } from '@/components/module-page';

interface Status {
  enabled: boolean;
  canAsk: boolean;
  disclosure: string;
}
interface Citation {
  n: number;
  documentId: string;
  title: string;
  heading: string | null;
  page: number | null;
}
interface Answer {
  id: string;
  outcome: 'answered' | 'refused' | 'no_answer' | 'unavailable';
  answer: string | null;
  message: string | null;
  citations: Citation[];
  disclosure: string;
  model: string | null;
  /** Help centre articles for this reader that match the question (ADR-0190). */
  helpArticles?: Array<{ slug: string; title: string; summary: string }>;
}
interface Exchange {
  key: string;
  question: string;
  result: Answer;
  feedback?: 'helpful' | 'not_helpful';
}

const QUESTION_MAX = 1000;

/** Renders [n] citation markers as links to the numbered source list of the same answer. */
function AnswerText({
  text,
  answerId,
  label,
}: {
  text: string;
  answerId: string;
  label: (n: number) => string;
}) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <p className="max-w-[var(--prose-width)] whitespace-pre-line text-body">
      {parts.map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p);
        if (!m) return <React.Fragment key={i}>{p}</React.Fragment>;
        return (
          <sup key={i}>
            <a
              href={`#src-${answerId}-${m[1]}`}
              aria-label={label(Number(m[1]))}
              className="px-0.5 text-footnote"
            >
              [{m[1]}]
            </a>
          </sup>
        );
      })}
    </p>
  );
}

export default function AskHrPage() {
  const t = useT();
  const toast = useToast();
  const status = useApi<Status>('/v1/ai/status');
  const [question, setQuestion] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [exchanges, setExchanges] = React.useState<Exchange[]>([]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3) return;
    setBusy(true);
    try {
      const result = await api<Answer>('/v1/ai/ask', {
        method: 'POST',
        json: { question: q },
        capability: 'askHr.use',
      });
      setExchanges((xs) => [{ key: result.id, question: q, result }, ...xs]);
      setQuestion('');
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function rate(x: Exchange, rating: 'helpful' | 'not_helpful') {
    try {
      await api(`/v1/ai/questions/${x.result.id}/feedback`, {
        method: 'POST',
        json: { rating },
        capability: 'askHr.use',
      });
      setExchanges((xs) => xs.map((y) => (y.key === x.key ? { ...y, feedback: rating } : y)));
    } catch (err) {
      toast({ title: err instanceof ApiProblem ? err.title : t('common.error'), tone: 'danger' });
    }
  }

  const open = async (documentId: string) =>
    window.open(
      (await api<{ url: string }>(`/v1/documents/${documentId}/download`)).url,
      '_blank',
      'noopener',
    );

  // Ask HR is a tab of Help only while the workspace may use it; otherwise the page has its own h1.
  if (!status.data && !status.error) return <Skeleton className="h-64 w-full" />;
  if (!status.data?.canAsk) {
    return (
      <div className="flex flex-col gap-6">
        <PageIntro title={t('askHr.title')} titleIsTab />
        <EmptyState icon={<BotOff aria-hidden />} title={t('askHr.off.title')} body={t('askHr.off.body')} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageIntro title={t('askHr.title')} titleIsTab />
      <div
        role="note"
        aria-label={t('askHr.disclosureShort')}
        className="flex items-start gap-3 rounded-lg border border-accent bg-accent-subtle p-4"
        data-testid="ai-disclosure"
      >
        <Bot aria-hidden className="mt-0.5 h-5 w-5 shrink-0 stroke-[1.5] text-accent" />
        <p className="max-w-[var(--prose-width)] text-callout">{t('askHr.disclosure')}</p>
      </div>
      <Card>
        <form onSubmit={ask} className="flex flex-col gap-4">
          <p className="text-callout text-text-secondary">{t('askHr.intro')}</p>
          <Field id="ask-question" label={t('askHr.questionLabel')} hint={t('askHr.questionHint')}>
            {(p) => (
              <Textarea
                {...p}
                required
                minLength={3}
                maxLength={QUESTION_MAX}
                rows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            )}
          </Field>
          <div>
            <Button type="submit" loading={busy}>
              {busy ? t('askHr.asking') : t('askHr.ask')}
            </Button>
          </div>
        </form>
      </Card>

      <section aria-live="polite" aria-label={t('askHr.title')} className="flex flex-col gap-4">
        {exchanges.length === 0 ? (
          <p className="text-footnote text-text-secondary">{t('askHr.empty')}</p>
        ) : null}
        {exchanges.map((x) => (
          <article key={x.key} className="flex flex-col gap-3" data-testid="ai-exchange">
            <div>
              <h2 className="text-footnote font-semibold text-text-secondary">{t('askHr.you')}</h2>
              <p className="text-callout">{x.question}</p>
            </div>
            <Card className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral" className="inline-flex items-center gap-1">
                  <Bot aria-hidden className="h-4 w-4 stroke-[1.5]" />
                  {t('askHr.aiLabel')}
                </Badge>
                {x.result.model ? (
                  <span className="text-footnote text-text-secondary">
                    {t('askHr.modelLabel', { model: x.result.model })}
                  </span>
                ) : null}
              </div>
              {x.result.answer ? (
                <AnswerText
                  text={x.result.answer}
                  answerId={x.result.id}
                  label={(n) => t('askHr.citation', { n })}
                />
              ) : (
                <p className="max-w-[var(--prose-width)] text-body" data-testid="ai-message">
                  {x.result.message}
                </p>
              )}
              {x.result.citations.length ? (
                <div>
                  <h3 className="text-footnote font-semibold">{t('askHr.sources')}</h3>
                  <ol className="mt-1 flex flex-col gap-1">
                    {x.result.citations.map((c) => (
                      <li
                        key={c.n}
                        id={`src-${x.result.id}-${c.n}`}
                        className="flex items-start gap-2 text-callout"
                      >
                        <span className="text-footnote text-text-secondary">[{c.n}]</span>
                        <FileText aria-hidden className="mt-0.5 h-4 w-4 shrink-0 stroke-[1.5] text-accent" />
                        <button
                          type="button"
                          className="text-left text-accent hover:underline"
                          onClick={() => open(c.documentId)}
                        >
                          {c.title}
                          {c.heading ? ` — ${c.heading}` : ''}
                          {c.page ? ` (${t('askHr.page', { page: c.page })})` : ''}
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
              {x.result.helpArticles?.length ? (
                <div>
                  <h3 className="text-footnote font-semibold">{t('visibility.help.askHrArticles')}</h3>
                  <ul className="mt-1 flex flex-col gap-1">
                    {x.result.helpArticles.map((a) => (
                      <li key={a.slug} className="text-callout">
                        <Link href={`/app/help/${a.slug}`}>{a.title}</Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="text-footnote text-text-secondary">{x.result.disclosure}</p>
              {x.result.outcome === 'answered' || x.result.outcome === 'no_answer' ? (
                <div
                  className="flex flex-wrap items-center gap-2"
                  role="group"
                  aria-label={t('askHr.feedbackPrompt')}
                >
                  <span className="text-footnote">{t('askHr.feedbackPrompt')}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-pressed={x.feedback === 'helpful'}
                    disabled={!!x.feedback}
                    onClick={() => rate(x, 'helpful')}
                  >
                    <ThumbsUp aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('askHr.helpful')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-pressed={x.feedback === 'not_helpful'}
                    disabled={!!x.feedback}
                    onClick={() => rate(x, 'not_helpful')}
                  >
                    <ThumbsDown aria-hidden className="h-4 w-4 stroke-[1.5]" />
                    {t('askHr.notHelpful')}
                  </Button>
                  {x.feedback ? (
                    <span role="status" className="text-footnote text-text-secondary">
                      {t('askHr.feedbackThanks')}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </Card>
          </article>
        ))}
      </section>
    </div>
  );
}
