import { Messages } from '@/lib/i18n-scope';

export default function PeopleDetailLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['admin.leaver', 'admin.balances', 'admin.transfer', 'admin.userPicker', 'admin.optional', 'admin.absence.department', 'documents.empty', 'timeOff.type', 'timeOff.entitlement', 'timeOff.carriedOver', 'timeOff.taken', 'timeOff.booked', 'rota.location']}>{children}</Messages>;
}
