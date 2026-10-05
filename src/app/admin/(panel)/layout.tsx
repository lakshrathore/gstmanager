import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AdminNav } from '@/components/admin/AdminNav';
import { getSuperAdmin } from '@/server/superadmin';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await getSuperAdmin();
  if (!admin) redirect('/admin/login');
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <AdminNav admin={{ name: admin.name, email: admin.email }} />
      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
