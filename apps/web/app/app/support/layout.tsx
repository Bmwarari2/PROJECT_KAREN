import { Messages } from '@/lib/i18n-scope';

export default function SupportLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages ns={['support', 'listView', 'pricing.plans', 'actionable.support', 'actionable.hr.contact']}>
      {children}
    </Messages>
  );
}
