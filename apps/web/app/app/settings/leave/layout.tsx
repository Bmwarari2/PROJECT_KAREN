import { Messages } from '@/lib/i18n-scope';

export default function LeaveLayout({ children }: { children: React.ReactNode }) {
  return (
    <Messages
      ns={[
        'admin.leave',
        'admin.balances',
        'people.asOf',
        'timeOff.type',
        'timeOff.entitlement',
        'timeOff.carriedOver',
        'timeOff.taken',
        'timeOff.booked',
      ]}
    >
      {children}
    </Messages>
  );
}
