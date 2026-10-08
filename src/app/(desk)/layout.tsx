import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuth, can } from '@/server/auth';
import { licenseState } from '@/server/license';
import { Sidebar } from '@/components/Sidebar';

export default async function DeskLayout({ children }: LayoutProps<'/'>) {
  const auth = await getAuth();
  if (!auth) redirect('/login');
  const lic = await licenseState(auth.orgId);
  const banner =
    lic.status !== 'active'
      ? { tone: 'border-red-ink/30 bg-red-tint text-red-ink', text: lic.status === 'none' ? 'No license – the workspace is read-only.' : `License ${lic.status} – the workspace is read-only.` }
      : lic.daysLeft != null && lic.daysLeft <= 7
        ? { tone: 'border-amber/30 bg-amber-tint text-amber', text: `Your ${lic.plan?.name ?? ''} license expires in ${lic.daysLeft} day${lic.daysLeft === 1 ? '' : 's'}.` }
        : null;
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      {/* The dark column runs the full page height; the sidebar inside it stays in view while scrolling. */}
      <div className="md:bg-ink">
        <Sidebar user={{ name: auth.name, role: auth.role }} plan={lic.status === 'active' ? lic.plan?.name ?? null : null} canManageTeam={can(auth, 'org:manage')} canReset={can(auth, 'org:reset')} />
      </div>
      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">
        {banner && (
          <div role="status" className={`mx-auto mb-6 flex max-w-5xl flex-wrap items-center justify-between gap-2 rounded-md border px-4 py-3 text-[13.5px] ${banner.tone}`}>
            <span>{banner.text}</span>
            <Link href="/license" className="font-semibold underline">Manage license</Link>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
