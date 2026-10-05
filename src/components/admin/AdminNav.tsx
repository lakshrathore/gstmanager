'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { call } from '@/lib/client';

const LINKS = [
  { href: '/admin', label: 'Customers' },
  { href: '/admin/licenses', label: 'Licenses' },
  { href: '/admin/packages', label: 'Packages' },
  { href: '/admin/account', label: 'My account' },
];

export function AdminNav({ admin }: { admin: { name: string; email: string } }) {
  const path = usePathname();
  const router = useRouter();
  const active = (h: string) => (h === '/admin' ? path === '/admin' : path.startsWith(h));
  return (
    <aside className="flex items-center justify-between gap-4 border-b border-rule bg-[#1d1a2e] px-4 py-3 text-white md:sticky md:top-0 md:h-screen md:flex-col md:items-stretch md:justify-start md:border-0 md:px-4 md:py-6">
      <Link href="/admin" className="text-[16px] font-semibold leading-tight">
        GST Return Desk
        <span className="mt-1 block w-fit rounded bg-amber-tint px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber">Super admin</span>
      </Link>
      <nav className="flex gap-1 overflow-x-auto md:mt-8 md:flex-col">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={active(l.href) ? 'page' : undefined}
            className={`whitespace-nowrap rounded-md px-3 py-2 text-[13.5px] ${active(l.href) ? 'bg-white/12 font-semibold' : 'text-white/70 hover:text-white'}`}>
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="hidden text-[12.5px] text-white/60 md:mt-auto md:block">
        <p className="text-white">{admin.name}</p>
        <p className="break-all">{admin.email}</p>
        <button className="mt-3 text-white/80 underline hover:text-white" onClick={async () => { await call('/api/admin/auth/logout', { method: 'POST' }); router.replace('/admin/login'); }}>Sign out</button>
      </div>
    </aside>
  );
}
