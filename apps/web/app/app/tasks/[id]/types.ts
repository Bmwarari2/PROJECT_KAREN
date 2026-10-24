/** `GET /v1/tasks/:id` (ADR-0160, ADR-0191 to ADR-0193). */
export interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  source: string;
  status: string;
  dueOn: string | null;
  createdAt: string;
  completedAt: string | null;
  completedByName: string | null;
  subject: { id: string; name: string } | null;
  assigneeRole: string | null;
  assigneeName: string | null;
  workflow: { id: string; kind: string; name: string } | null;
  href: string;
  canComplete: boolean;
  /** The main button: its label in the reader's locale and the page that does the work. */
  action: { kind: string; opens: string; label: string; href: string; landed: boolean } | null;
  /** The live status of the record the task is linked to. */
  recordStatus: { text: string; tone: string } | null;
  /** "Comes from": the real source, and its page when the reader may open it. */
  origin: { source: string; label: string; href: string | null };
  closesItself: boolean;
  /** Open and past its due date, in the viewer's zone. */
  overdue: boolean;
  completedVia: 'manual' | 'record' | null;
  completionNote: string | null;
}

/**
 * The task's API path for the reader's locale and account zone (without one, the API uses the workspace's
 * zone for "overdue"). The server render and the page use the same path, so the page reuses the first data.
 */
export const taskPath = (id: string, locale: string, zone: string | null | undefined) =>
  `/v1/tasks/${encodeURIComponent(id)}?locale=${locale}${zone ? `&zone=${encodeURIComponent(zone)}` : ''}`;
