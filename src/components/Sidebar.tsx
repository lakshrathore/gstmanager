'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { call } from '@/lib/client';

export function Sidebar({ user, plan, canManageTeam, canReset }: { user: { name: string; role: string }; plan: string | null; canManageTeam: boolean; canReset: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const links = [
    { href: '/companies', label: 'Companies' },
    { href: '/firm', label: 'Firm dashboard' },
    { href: '/documents', label: 'Client documents' },
    { href: '/search', label: 'Search' },
    { href: '/assistant', label: 'Ask the documents' },
    { href: '/downloads', label: 'Downloads' },
    { href: '/', label: 'GSTR-1' },
    { href: '/gstr3b', label: 'GSTR-3B' },
    { href: '/gstr9', label: 'GSTR-9' },
    { href: '/gstr9c', label: 'GSTR-9C' },
    { href: '/recon', label: 'Reconciliation' },
    { href: '/tools', label: 'Validators' },
    ...(canManageTeam ? [{ href: '/team', label: 'Team' }] : []),
    { href: '/license', label: 'License' },
    ...(canReset ? [{ href: '/settings', label: 'Settings' }] : []),
  ];
  const active = (h: string) => (h === '/' ? path === '/' || path.startsWith('/returns') : path === h || path.startsWith(`${h}/`));
  return (
    <aside className="flex items-center justify-between gap-4 border-b border-rule bg-ink px-4 py-3 text-white md:sticky md:top-0 md:h-screen md:flex-col md:overflow-y-auto md:items-stretch md:justify-start md:border-0 md:px-4 md:py-6">
      <Link href="/" className="text-[16px] font-semibold leading-tight">GST Return<br className="hidden md:block" /> Desk</Link>
      <nav className="flex gap-1 md:mt-8 md:flex-col">
        {links.map((l) => (
          <Link key={l.href} href={l.href} aria-current={active(l.href) ? 'page' : undefined}
            className={`rounded-md px-3 py-2 text-[13.5px] ${active(l.href) ? 'bg-white/12 font-semibold' : 'text-white/70 hover:text-white'}`}>
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="hidden text-[12.5px] text-white/60 md:mt-auto md:block">
        <p className="text-white">{user.name}</p>
        <p className="capitalize">{user.role}</p>
        <p className="mt-1">{plan ? `${plan} plan` : 'No active license'}</p>
        <button className="mt-3 text-white/80 underline hover:text-white" onClick={async () => { await call('/api/auth/logout', { method: 'POST' }); router.replace('/login'); }}>Sign out</button>
      </div>
    </aside>
  );
}
