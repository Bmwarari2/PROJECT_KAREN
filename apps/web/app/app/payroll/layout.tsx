import { Messages } from '@/lib/i18n-scope';

export default function PayrollLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['payroll']}>{children}</Messages>;
}
