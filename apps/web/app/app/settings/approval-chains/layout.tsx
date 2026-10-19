import { Messages } from '@/lib/i18n-scope';

export default function ApprovalChainsLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.approvals']}>{children}</Messages>;
}
