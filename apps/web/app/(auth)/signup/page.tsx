import { serverContext } from '@/lib/server';
import { SignUpForm } from './form';

export async function generateMetadata() {
  const { t } = await serverContext();
  return { title: t('auth.signUp.title') };
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ region?: string; company?: string; slug?: string }>;
}) {
  const sp = await searchParams;
  return <SignUpForm initialRegion={sp.region} initialCompany={sp.company} initialSlug={sp.slug} />;
}
