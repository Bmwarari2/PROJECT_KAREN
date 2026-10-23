import { serverContext } from '@/lib/server';
import { SignInForm } from './form';

export async function generateMetadata() {
  const { t } = await serverContext();
  return { title: t('auth.signIn.title') };
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; error?: string }>;
}) {
  const sp = await searchParams;
  return <SignInForm initialWorkspace={sp.workspace ?? ''} />;
}
