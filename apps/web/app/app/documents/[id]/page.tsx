import { serverApiView } from '@/lib/server-api';
import { DocumentViewer, type DocView } from './viewer';

/**
 * The document viewer (ADR-0168). The web server fetches the document's details with the viewer's own cookie,
 * so its title and details are in the first HTML (the API audits that as the view); the PDF itself loads in the
 * browser. Rendered per request and never cached (the /app layout).
 */
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentViewer id={id} initial={await serverApiView<DocView>('/v1/documents', id)} />;
}
