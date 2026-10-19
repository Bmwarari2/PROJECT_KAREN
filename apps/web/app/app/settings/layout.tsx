import { SettingsFrame } from './frame';

/** Every settings page shares the settings sub-navigation. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsFrame>{children}</SettingsFrame>;
}
