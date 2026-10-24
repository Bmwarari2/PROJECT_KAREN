import { serverApiView } from '@/lib/server-api';
import { Payslip, type Detail } from './payslip';

/**
 * One payslip (ADR-0167). The web server fetches it with the viewer's own cookie, so the statement is in the
 * first HTML (the API audits that as the view). Rendered per request and never cached (the /app layout).
 */
export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Payslip id={id} initial={await serverApiView<Detail>('/v1/payslips', id)} />;
}
