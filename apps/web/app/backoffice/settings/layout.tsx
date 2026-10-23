import { Messages } from '@/lib/i18n-scope';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages ns={['backoffice.settings', 'pricing.plans', 'support.channels', 'support.coverage']}>
      {children}
    </Messages>
  );
}
