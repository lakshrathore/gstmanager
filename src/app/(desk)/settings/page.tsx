import { redirect } from 'next/navigation';
import { can, getAuth } from '@/server/auth';
import { ResetData } from '@/components/ResetData';

export default async function SettingsPage() {
  const auth = await getAuth();
  if (!auth) redirect('/login');
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-[24px] font-semibold tracking-tight">Settings</h1>
      {can(auth, 'org:reset')
        ? <ResetData />
        : <p className="text-ink-soft">Only the workspace owner can change these settings.</p>}
    </div>
  );
}
