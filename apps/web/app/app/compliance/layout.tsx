import { ComplianceNav } from './ui';

export default function ComplianceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <ComplianceNav />
      {children}
    </div>
  );
}
