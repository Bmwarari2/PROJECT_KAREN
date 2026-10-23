import { notFound } from 'next/navigation';
import { Inbox } from 'lucide-react';
import { Badge, Button, Card, CardTitle, EmptyState, Field, Input, Section, Skeleton, Table, TD, TH, THead, TR } from '@thapsus/ui';
import { serverContext } from '@/lib/server';
import { GalleryInteractive } from './interactive';

export const metadata = { robots: { index: false } };

/**
 * Component gallery: every packages/ui component in one place, used for visual regression. A
 * development tool, so production does not serve it (ASVS V15.2.3).
 */
export default async function Gallery() {
  if (process.env.APP_ENV === 'prod') notFound();
  const { t } = await serverContext();
  const g = (k: string) => t(`gallery.${k}`);
  return (
    <main id="main">
      <Section tone="bg">
        <h1 className="text-title-1">{g('title')}</h1>
        <p className="mt-2 text-body text-text-secondary">{g('lead')}</p>

        <h2 className="mt-12 text-title-3">{g('typography')}</h2>
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-headline">{g('sampleHeadline')}</p>
          <p className="text-title-1">{g('sampleTitle')}</p>
          <p className="text-title-2">{g('sampleTitle')}</p>
          <p className="text-title-3">{g('sampleTitle')}</p>
          <p className="text-body-lg text-text-secondary">{g('sampleBody')}</p>
          <p className="text-body">{g('sampleBody')}</p>
          <p className="text-callout">{g('sampleBody')}</p>
          <p className="text-footnote text-text-secondary">{g('sampleBody')}</p>
        </div>

        <h2 className="mt-12 text-title-3">{g('buttons')}</h2>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button>{g('primary')}</Button>
          <Button variant="secondary">{g('secondary')}</Button>
          <Button variant="ghost">{g('ghost')}</Button>
          <Button variant="danger">{g('danger')}</Button>
          <Button variant="link">{g('link')}</Button>
          <Button size="sm">{g('small')}</Button>
          <Button size="lg">{g('large')}</Button>
          <Button loading>{g('loading')}</Button>
          <Button disabled>{g('disabled')}</Button>
        </div>

        <h2 className="mt-12 text-title-3">{g('forms')}</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field id="g-name" label={g('fieldLabel')} hint={g('fieldHint')}>
            {(p) => <Input {...p} defaultValue={g('fieldValue')} />}
          </Field>
          <Field id="g-err" label={g('fieldLabel')} error={g('fieldError')}>
            {(p) => <Input {...p} defaultValue="" />}
          </Field>
        </div>

        <h2 className="mt-12 text-title-3">{g('badges')}</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge>{g('neutral')}</Badge>
          <Badge tone="accent">{g('accent')}</Badge>
          <Badge tone="success">{g('success')}</Badge>
          <Badge tone="warning">{g('warning')}</Badge>
          <Badge tone="danger">{g('danger')}</Badge>
        </div>

        <h2 className="mt-12 text-title-3">{g('cards')}</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Card>
            <CardTitle>{g('cardTitle')}</CardTitle>
            <p className="mt-2 text-callout text-text-secondary">{g('sampleBody')}</p>
          </Card>
          <Card>
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="mt-3 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-4/5" />
          </Card>
          <EmptyState icon={<Inbox aria-hidden />} title={g('emptyTitle')} body={g('emptyBody')} action={<Button size="sm">{g('primary')}</Button>} />
        </div>

        <h2 className="mt-12 text-title-3">{g('table')}</h2>
        <div className="mt-4">
          <Table scrollLabel={g('table')}>
            <THead>
              <tr>
                <TH>{g('colName')}</TH>
                <TH>{g('colTeam')}</TH>
                <TH className="text-right">{g('colBalance')}</TH>
                <TH>{t('common.status')}</TH>
              </tr>
            </THead>
            <tbody>
              {[
                ['Avery Example', 'Engineering', '12.5', 'success'],
                ['Blake Sample', 'Design', '3.0', 'warning'],
                ['Casey Fictional', 'Support', '20.0', 'accent'],
              ].map(([n, team, bal, tone]) => (
                <TR key={n}>
                  <TD>{n}</TD>
                  <TD>{team}</TD>
                  <TD className="text-right">{bal}</TD>
                  <TD>
                    <Badge tone={tone as 'success'}>{g(tone!)}</Badge>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </div>

        <h2 className="mt-12 text-title-3">{g('interactive')}</h2>
        <GalleryInteractive />
      </Section>
      <Section tone="inverse">
        <p className="text-headline">{g('inverseTitle')}</p>
        <p className="mt-3 text-body-lg opacity-80">{g('sampleBody')}</p>
      </Section>
    </main>
  );
}
