import { redirect } from 'next/navigation';
import { getAuth, can } from '@/server/auth';
import { Sidebar } from '@/components/Sidebar';

export default async function DeskLayout({ children }: LayoutProps<'/'>) {
  const auth = await getAuth();
  if (!auth) redirect('/login');
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <Sidebar user={{ name: auth.name, role: auth.role }} canManageTeam={can(auth, 'org:manage')} canReset={can(auth, 'org:reset')} />
      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
