import { redirect } from 'next/navigation';

/** Settings → Documents opens on its templates. */
export default function DocumentSettingsPage() {
  redirect('/app/settings/documents/templates');
}
