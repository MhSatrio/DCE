import { useEffect, useRef, useState } from 'react';
import { mainProvider } from '../db/provider';
import { renderDataFor } from '../db/repo';
import type { ContentRecord } from '../db/schema';
import { renderDoc } from '../engine/render';
import type { Issue, NjsDoc } from '../engine/types';

/** Renders a template for a record with the exact engine used for batches (main thread, scaled). */
export function Preview(props: { doc: NjsDoc | undefined; record: ContentRecord | undefined; width?: number; onIssues?: (i: Issue[], ms: number) => void; className?: string }) {
  const [url, setUrl] = useState<string>();
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const W = props.width ?? 420;
  useEffect(() => {
    const doc = props.doc;
    if (!doc) { setUrl(undefined); return; }
    const my = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const t0 = performance.now();
        const data = props.record ? renderDataFor(props.record, doc) : null;
        const out = await renderDoc(doc, data, mainProvider, { format: 'png', outW: Math.round(W * (window.devicePixelRatio > 1 ? 2 : 1)), failOnError: false });
        if (my !== seq.current) return;
        const u = URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: 'image/png' }));
        setUrl((old) => { if (old) URL.revokeObjectURL(old); return u; });
        setErr('');
        props.onIssues?.(out.issues, performance.now() - t0);
      } catch (e) { if (my === seq.current) setErr(e instanceof Error ? e.message : String(e)); }
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.doc, props.record, W]);
  useEffect(() => () => { setUrl((old) => { if (old) URL.revokeObjectURL(old); return undefined; }); }, []);
  if (err) return <div className="callout err">{err}</div>;
  const ratio = props.doc ? props.doc.canvas.height / props.doc.canvas.width : 1;
  return (
    <div className={props.className} style={{ width: '100%', maxWidth: W, aspectRatio: `${1 / ratio}`, background: '#fff', border: '1px solid var(--line-strong)', borderRadius: 4, overflow: 'hidden' }}>
      {url && <img src={url} alt={`Preview of ${props.doc?.meta.name}`} style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }} />}
    </div>
  );
}
