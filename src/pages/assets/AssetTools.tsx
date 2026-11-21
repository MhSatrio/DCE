import { useEffect, useState } from 'react';
import { Copy, Eraser, Pencil, Spline } from 'lucide-react';
import { cutoutPreview, removeBackground, traceImageToSvg, type TraceMode } from '../../assets/tools';
import { resyncClosing } from '../../db/carousel';
import { storeAssetBlob, storeSvgAsset } from '../../db/repo';
import { assetAddress, db, type AssetRow } from '../../db/schema';
import { Dialog, download, Spinner } from '../../ui/kit';
import { useBlobUrl } from '../../ui/hooks';
import { notify } from '../../ui/store';
import { SvgEditor } from './SvgEditor';

/** The address of an image for Buffer and the carousels: its public address, else where it was imported from. */
export function publicAddress(a: AssetRow): string | undefined {
  return assetAddress(a);
}

const WEB_ADDRESS = /^https?:\/\/\S+$/i;

/** The public address of an image, editable (Buffer needs a link that opens in a browser). */
export function PublicUrlField({ asset }: { asset: AssetRow }) {
  const current = asset.publicUrl ?? '';
  const [val, setVal] = useState(current);
  const [err, setErr] = useState('');
  useEffect(() => { setVal(current); setErr(''); }, [current, asset.id]);
  const v = val.trim();
  const shown = publicAddress(asset);

  const save = async () => {
    if (v && !WEB_ADDRESS.test(v)) { setErr('Use a full address that starts with https://'); return; }
    setErr('');
    try {
      await db.assets.update(asset.id, { publicUrl: v });
      await resyncClosing(asset.id);   // a carousel that ends with this image gets the new address
      notify('success', v ? 'Public address saved.' : 'Public address removed.');
    } catch (e) { notify('error', e instanceof Error ? e.message : String(e)); }
  };
  const copy = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown);
      notify('success', 'Address copied.');
    } catch { notify('warn', shown, 9000); }
  };

  return (
    <div className="fld">
      <span>Public address (Buffer and carousels use it)</span>
      <div className="row" style={{ gap: 6 }}>
        <input aria-label="Public address" value={val} placeholder="https://…/image.png" style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
        <button className="btn" disabled={v === current} onClick={() => void save()}>Save</button>
        <button className="btn" disabled={!shown} aria-label="Copy address" title="Copy address" onClick={() => void copy()}><Copy size={14} /></button>
      </div>
      {err && <div className="callout err" role="alert">{err}</div>}
      <div className="muted small">
        {asset.publicUrl ? 'The address this image is published at.'
          : asset.sourceUrl ? 'Not set: the address it was imported from is used for now.'
            : 'Not set. Paste the address the image is published at; it must open in a browser.'}
      </div>
    </div>
  );
}

/** The tools of one asset: remove the background (raster images), trace to SVG, and edit the SVG (vector editor). */
export function AssetTools({ asset }: { asset: AssetRow }) {
  const [dlg, setDlg] = useState<'bg' | 'trace' | 'svg' | null>(null);
  const isSvg = asset.mime === 'image/svg+xml';
  return (
    <>
      {!isSvg && (
        <div className="row wrap">
          <button className="btn" onClick={() => setDlg('bg')}><Eraser size={14} /> Remove background</button>
          <button className="btn" onClick={() => setDlg('trace')}><Spline size={14} /> Trace to SVG</button>
        </div>
      )}
      {isSvg && (
        <div className="row wrap">
          <button className="btn" onClick={() => setDlg('svg')}><Pencil size={14} /> Edit SVG</button>
          <button className="btn" onClick={() => download(asset.blob, asset.name)}>Export SVG</button>
        </div>
      )}
      {dlg === 'bg' && <BackgroundDialog asset={asset} onClose={() => setDlg(null)} />}
      {dlg === 'trace' && <TraceDialog asset={asset} onClose={() => setDlg(null)} />}
      {dlg === 'svg' && <SvgEditor asset={asset} onClose={() => setDlg(null)} />}
    </>
  );
}

function BackgroundDialog({ asset, onClose }: { asset: AssetRow; onClose: () => void }) {
  const [tol, setTol] = useState(40);
  const [enclosed, setEnclosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Blob | null>(null);
  const previewUrl = useBlobUrl(preview);
  const beforeUrl = useBlobUrl(asset.blob);
  // the preview is recomputed (small, so it is quick) whenever the settings change
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      cutoutPreview(asset.blob, tol, enclosed).then((b) => { if (live) setPreview(b); }).catch(() => undefined);
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [asset.blob, tol, enclosed]);
  const run = async () => {
    setBusy(true);
    try {
      const out = await removeBackground(asset.blob, tol, enclosed);
      const base = asset.name.replace(/\.[^.]+$/, '');
      await storeAssetBlob(out.blob, `${base} (no background).png`, { category: asset.category, tags: asset.tags });
      notify('success', 'Background removed: a new transparent PNG was added to the assets.');
      onClose();
    } catch (e) { notify('error', e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog title="Remove background" onClose={onClose} size="mid" foot={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? <Spinner /> : null} Remove background</button>
    </>}>
      <div className="col" style={{ gap: 8 }}>
        <div className="small muted">The background is learned from the image's border (several colours, so a soft backdrop works too). The background that touches the border becomes transparent; the result is a new PNG and the original stays. Plain, white or softly lit backgrounds work best. Clear glass or a product of the same colour as the backdrop needs a manual check.</div>
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: 4, justifyItems: 'center' }}>
            <span className="small muted">Before</span>
            {beforeUrl ? <img src={beforeUrl} alt="Original" style={{ maxWidth: 220, maxHeight: 220 }} /> : <Spinner />}
          </div>
          <div style={{ display: 'grid', gap: 4, justifyItems: 'center' }}>
            <span className="small muted">After (preview)</span>
            {previewUrl ? <img src={previewUrl} alt="Background removed (preview)" style={{ maxWidth: 220, maxHeight: 220, background: 'repeating-conic-gradient(#eef2f6 0 25%, #fff 0 50%) 0 0 / 14px 14px' }} /> : <Spinner />}
          </div>
        </div>
        <label className="fld"><span>How close a colour must be to the background ({tol})</span>
          <input type="range" min={5} max={120} aria-label="Background tolerance" value={tol} onChange={(e) => setTol(Number(e.target.value))} />
        </label>
        <label className="chk"><input type="checkbox" aria-label="Also remove white areas inside the outline" checked={enclosed} onChange={(e) => setEnclosed(e.target.checked)} /> Also remove background-coloured areas inside the outline (line art, the white inside a drawn flask)</label>
      </div>
    </Dialog>
  );
}

function TraceDialog({ asset, onClose }: { asset: AssetRow; onClose: () => void }) {
  const [detail, setDetail] = useState<'low' | 'medium' | 'high'>('medium');
  const [mode, setMode] = useState<TraceMode>('areas');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const t = await traceImageToSvg(asset.blob, detail, mode);
      const base = asset.name.replace(/\.[^.]+$/, '');
      await storeSvgAsset(t.svg, `${base} (traced)`, asset.width || t.width, asset.height || t.height, { category: asset.category, tags: asset.tags });
      notify('success', 'Traced: a new editable SVG was added to the assets.');
      onClose();
    } catch (e) { notify('error', e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog title="Trace to SVG" onClose={onClose} size="mid" foot={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? <Spinner /> : null} Trace</button>
    </>}>
      <div className="col" style={{ gap: 8 }}>
        <div className="small muted">Converts the image into vector shapes of its colours. Made for flat illustrations, icons, logos and simple graphics; a photograph becomes a poster of flat areas. Afterwards you can recolour the shapes and move their points in the SVG editor.</div>
        <label className="fld" style={{ maxWidth: 420 }}><span>What to trace</span>
          <select aria-label="Trace mode" value={mode} onChange={(e) => setMode(e.target.value as TraceMode)}>
            <option value="areas">Colour areas: flat illustrations, logos, icons</option>
            <option value="line">Line art: the ink as outline shapes (a drawing on white)</option>
          </select>
        </label>
        <label className="fld" style={{ maxWidth: 320 }}><span>Detail</span>
          <select aria-label="Trace detail" value={detail} onChange={(e) => setDetail(e.target.value as 'low' | 'medium' | 'high')}>
            <option value="low">Low: few colours, smallest file</option>
            <option value="medium">Medium</option>
            <option value="high">High: more colours and paths</option>
          </select>
        </label>
      </div>
    </Dialog>
  );
}
