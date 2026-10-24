import { Messages } from '@/lib/i18n-scope';

export default function PeopleDetailLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'admin.leaver',
        'admin.balances',
        'admin.transfer',
        'admin.userPicker',
        'admin.optional',
        'admin.absence.department',
        'documents.empty',
        'timeOff.type',
        'timeOff.entitlement',
        'timeOff.carriedOver',
        'timeOff.taken',
        'timeOff.booked',
        'rota.location',
        'reports.enum',
        'actionable.person',
        'compliance.noAccess',
        'compliance.status',
        'compliance.rtw.title',
        'compliance.rtw.checkedOn',
        'compliance.rtw.listType',
        'compliance.rtw.followUp',
        'compliance.rtw.list',
      ]}
    >
      {children}
    </Messages>
  );
}
