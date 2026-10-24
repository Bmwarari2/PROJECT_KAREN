import { serverContext } from '@/lib/server';
import { ForgotPasswordForm } from './form';

export async function generateMetadata() {
  const { t } = await serverContext();
  return { title: t('auth.forgot.title') };
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  const sp = await searchParams;
  return <ForgotPasswordForm initialWorkspace={(sp.workspace ?? '').slice(0, 40)} />;
}
