'use client';

import { Fragment, type ReactNode } from 'react';

/**
 * The little markdown the assistant writes – paragraphs, bullet and numbered lists, **bold**,
 * *italic*, `code` and pipe tables – rendered as React elements (never as HTML, so nothing in an
 * answer can inject markup).
 */

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={m.index} className="num rounded bg-black/5 px-1">{t.slice(1, -1)}</code>);
    else out.push(<em key={m.index} className="text-ink-soft">{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const numeric = (s: string) => /^[₹\-−+]?\s?[\d,]+(\.\d+)?%?$/.test(s.replace(/\s/g, ''));

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={i} className="overflow-x-auto">
          <table className="ledger">
            <thead><tr>{head.map((h, j) => <th key={j} className={rows.every((r) => numeric(r[j] ?? '') || !r[j]) ? 'text-right' : ''}>{inline(h)}</th>)}</tr></thead>
            <tbody>{rows.map((r, k) => <tr key={k}>{head.map((_, j) => <td key={j} className={numeric(r[j] ?? '') ? 'num text-right' : ''}>{inline(r[j] ?? '')}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={i} className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-5`}>{items.map((x, k) => <li key={k}>{inline(x)}</li>)}</Tag>);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) { blocks.push(<p key={i} className="font-semibold">{inline(line.replace(/^#+\s*/, ''))}</p>); i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(\||[-*•]\s|\d+[.)]\s|#)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) { blocks.push(<p key={i}>{inline(lines[i++])}</p>); continue; }
    blocks.push(<p key={i}>{para.map((p, k) => <Fragment key={k}>{k > 0 && <br />}{inline(p)}</Fragment>)}</p>);
  }
  return <div className="space-y-2">{blocks}</div>;
}
