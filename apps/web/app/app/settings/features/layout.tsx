import { Messages } from '@/lib/i18n-scope';

// The flag names and descriptions come from the registry in @thapsus/core/features (platform.flags.*).
export default function FeaturesLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['platform.features', 'platform.flags']}>{children}</Messages>;
}
