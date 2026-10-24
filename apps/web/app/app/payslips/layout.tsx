import { Messages } from '@/lib/i18n-scope';

export default function PayslipsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['payslips', 'payslipView', 'docView']}>{children}</Messages>;
}
