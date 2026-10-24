import type { MyPayslip } from '@/components/payslips/my-payslips';
import { serverApi } from '@/lib/server-api';
import { PayslipsPage } from './payslips-page';

/**
 * Payslips (ADR-0167). The web server fetches the viewer's own payslips with their cookie, so the list is in
 * the first HTML and nothing below it moves when it arrives. Rendered per request and never cached.
 */
export default async function Page() {
  return <PayslipsPage initialPayslips={await serverApi<MyPayslip[]>('/v1/me/payslips')} />;
}
