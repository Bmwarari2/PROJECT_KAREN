import { Messages } from '@/lib/i18n-scope';
import { SettingsFrame } from './frame';

/** Every settings page shares the settings sub-navigation. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages ns={['admin.*', 'admin.nav', 'admin.section', 'admin.group', 'admin.index', 'admin.userPicker', 'admin.assignee', 'app.settings', 'platform.links', 'platform.status', 'platform.secretOnce', 'platform.errors', 'platform.featureOff', 'platform.backToSettings']}>
      <SettingsFrame>{children}</SettingsFrame>
    </Messages>
  );
}
