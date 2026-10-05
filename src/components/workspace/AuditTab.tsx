'use client';

import { useEffect, useState } from 'react';
import { Button, Notice, Panel } from '@/components/ui';
import { call } from '@/lib/client';

interface Entry { _id: string; seq: number; at: string; actorEmail: string; action: string; entity: string; meta: Record<string, unknown>; hash: string }

export function AuditTab({ id }: { id: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAtSeq?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call<{ entries: Entry[] }>(`/api/returns/${id}/audit`).then((r) => setEntries(r.entries)).catch((e) => setErr(e.message)); }, [id]);

  async function check() {
    setBusy(true);
    try { setVerify(await call('/api/audit/verify')); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Panel title="Audit trail" action={<Button variant="secondary" onClick={check} busy={busy}>Verify integrity</Button>}>
      {verify && <div className="mb-4"><Notice tone={verify.ok ? 'ok' : 'error'}>{verify.ok ? `Hash chain intact across ${verify.checked} entries.` : `Chain broken at entry #${verify.brokenAtSeq}. The log was altered outside the app.`}</Notice></div>}
      {err && <Notice tone="error">{err}</Notice>}
      {!entries ? <p className="text-ink-soft">Loading…</p> : (
        <ol className="space-y-0">
          {entries.map((e) => (
            <li key={e._id} className="grid gap-1 border-b border-rule py-3 sm:grid-cols-[170px_200px_1fr]">
              <span className="num text-[12.5px] text-ink-soft">#{e.seq} · {new Date(e.at).toLocaleString('en-IN')}</span>
              <span><span className="font-medium">{e.action}</span><br /><span className="text-[12.5px] text-ink-soft">{e.actorEmail}</span></span>
              <details className="min-w-0">
                <summary className="cursor-pointer text-ink-soft">Details</summary>
                <pre className="num mt-2 max-h-64 overflow-auto rounded bg-paper p-3 text-[11.5px]">{JSON.stringify(e.meta, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
