import Link from 'next/link';
import { CalendarDays, Clock, Globe2, ShieldCheck, Users, Workflow } from 'lucide-react';
import { Badge, buttonVariants, Card, Section } from '@thapsus/ui';
import { Reveal } from '@/components/client';
import { FeatureShowcase } from '@/components/showcase';
import { ProductMock } from '@/components/product-mock';
import { serverContext } from '@/lib/server';

export default async function Home() {
  const { t } = await serverContext();
  const regions = (['uk', 'eu', 'us'] as const).map((r) => ({ key: r, name: t(`regions.${r}`), body: t(`marketing.regions.${r}`) }));
  const features = [
    { key: 'people', icon: <Users aria-hidden /> },
    { key: 'timeOff', icon: <CalendarDays aria-hidden /> },
    { key: 'rota', icon: <Clock aria-hidden /> },
    { key: 'compliance', icon: <ShieldCheck aria-hidden /> },
  ].map((f) => ({ ...f, title: t(`marketing.features.${f.key}.title`), body: t(`marketing.features.${f.key}.body`) }));

  return (
    <>
      <Section tone="bg" className="pt-16 md:pt-24" labelledBy="hero-title">
        <div className="flex flex-col items-center text-center">
          <Badge tone="accent">{t('marketing.hero.eyebrow')}</Badge>
          <h1 id="hero-title" className="mt-5 max-w-[14ch] text-display text-text">
            {t('marketing.hero.title')}
          </h1>
          <p className="mt-6 max-w-[var(--prose-width)] text-body-lg text-text-secondary">{t('marketing.hero.lead')}</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/signup" className={buttonVariants({ size: 'lg' }) + ' no-underline'}>
              {t('marketing.hero.ctaPrimary')}
            </Link>
            <Link href="/pricing" className={buttonVariants({ size: 'lg', variant: 'secondary' }) + ' no-underline'}>
              {t('marketing.hero.ctaSecondary')}
            </Link>
          </div>
        </div>
        <Reveal className="mt-16">
          <ProductMock />
        </Reveal>
      </Section>

      <Section tone="surface" id="features" labelledBy="features-title">
        <h2 id="features-title" className="max-w-[18ch] text-headline">
          {t('marketing.features.title')}
        </h2>
        <p className="mt-4 max-w-[var(--prose-width)] text-body-lg text-text-secondary">{t('marketing.features.lead')}</p>
        <FeatureShowcase features={features} />
      </Section>

      <Section tone="inverse" labelledBy="residency-title">
        <div className="grid gap-12 md:grid-cols-2 md:items-center">
          <div>
            <Globe2 aria-hidden className="h-10 w-10 stroke-[1.25]" />
            <h2 id="residency-title" className="mt-6 text-headline">
              {t('marketing.residency.title')}
            </h2>
            <p className="mt-4 text-body-lg opacity-80">{t('marketing.residency.body')}</p>
          </div>
          <ul className="grid gap-4">
            {regions.map((r, i) => (
              <Reveal as="li" key={r.key} delay={i * 80} className="rounded-xl border border-text-inverse/20 p-6">
                <p className="text-title-3">{r.name}</p>
                <p className="mt-2 text-callout opacity-80">{r.body}</p>
              </Reveal>
            ))}
          </ul>
        </div>
      </Section>

      <Section tone="bg" labelledBy="fair-title">
        <div className="grid gap-6 md:grid-cols-3">
          {(['pricing', 'export', 'support'] as const).map((k, i) => (
            <Reveal key={k} delay={i * 80}>
              <Card size="marketing" className="h-full bg-surface shadow-none">
                <Workflow aria-hidden className="h-6 w-6 stroke-[1.5] text-accent" />
                <h3 className="mt-4 text-title-2">{t(`marketing.fair.${k}.title`)}</h3>
                <p className="mt-2 text-callout text-text-secondary">{t(`marketing.fair.${k}.body`)}</p>
              </Card>
            </Reveal>
          ))}
        </div>
        <h2 id="fair-title" className="sr-only">
          {t('marketing.fair.title')}
        </h2>
        <div className="mt-16 flex flex-col items-center text-center">
          <p className="max-w-[20ch] text-title-1">{t('marketing.cta.title')}</p>
          <Link href="/signup" className={buttonVariants({ size: 'lg' }) + ' mt-6 no-underline'}>
            {t('marketing.cta.button')}
          </Link>
        </div>
      </Section>
    </>
  );
}
