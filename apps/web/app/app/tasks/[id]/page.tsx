import { serverApi } from '@/lib/server-api';
import { serverContext } from '@/lib/server';
import { serverSession } from '@/lib/server-session';
import { TaskPage } from './task-page';
import { taskPath, type TaskDetail } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One task (ADR-0191). The web server fetches it with the viewer's own cookie, locale and account zone, so
 * the description and the main button are in the first HTML. Rendered per request and never cached (the
 * /app layout).
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ locale }, session] = await Promise.all([serverContext(), serverSession()]);
  const initial =
    UUID.test(id) && session
      ? await serverApi<TaskDetail>(taskPath(id, locale, session.timeZone))
      : undefined;
  return <TaskPage id={id} initial={initial} />;
}
