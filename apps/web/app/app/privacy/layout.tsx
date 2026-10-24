import { Messages } from '@/lib/i18n-scope';
import { PrivacyFrame } from './frame';

export default function PrivacyLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages ns={['privacy.ui', 'people.field', 'visibility.readOnly']}>
      <PrivacyFrame>{children}</PrivacyFrame>
    </Messages>
  );
}
