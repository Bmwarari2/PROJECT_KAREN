import { Messages } from '@/lib/i18n-scope';

export default function RightToWorkLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['compliance.rtw', 'actionable.rtw']}>{children}</Messages>;
}
