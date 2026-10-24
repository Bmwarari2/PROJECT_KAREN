import type { SettingsSection } from './sections';

/** The message key prefix of a settings section's title and summary (`.title`, `.body`). */
export const sectionMessages = (s: SettingsSection) =>
  s.platform ? `platform.links.${s.platform}` : `admin.section.${s.key}`;
