import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { createCarouselTable, MAX_GROUP } from '../../db/carousel';
import { assetAddress, db } from '../../db/schema';
import { allTables, createTable, fieldsOf } from '../../db/tables';
import { Dialog } from '../../ui/kit';
import { notify, useStore } from '../../ui/store';
import { recordsStore, tablesStore } from '../../db/stores';

/** "New table": a blank table, or a carousel table built from the images of another table. */
const PRESETS = [3, 4, 6, 7, 10, 20] as const;
const URL_TYPES = ['url', 'text', 'longtext'];

export function NewTableDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  // the source tables and their fields follow the data while the dialog is open
  useStore(tablesStore, (s) => s.tables);
  useStore(tablesStore, (s) => s.fields);
  useStore(recordsStore, (s) => s.fields);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'blank' | 'carousel'>('blank');
  const [source, setSource] = useState('');
  const [linkField, setLinkField] = useState('');
  const [preset, setPreset] = useState<number | 'custom'>(6);
  const [custom, setCustom] = useState(10);
  const [closing, setClosing] = useState('');
  const [busy, setBusy] = useState(false);
  const tables = allTables();
  const images = useLiveQuery(() => db.assets.toArray(), [], undefined);
  const addressed = useMemo(() => (images ?? []).filter((a) => assetAddress(a)).sort((a, b) => a.name.localeCompare(b.name)), [images]);
  const sourceFields = useMemo(() => (source ? fieldsOf(source).filter((f) => URL_TYPES.includes(f.type)) : []), [source]);
  const groupSize = preset === 'custom' ? custom : preset;
  const carouselValid = !!source && !!linkField && Number.isInteger(groupSize) && groupSize >= 1 && groupSize <= MAX_GROUP
    && (!closing || groupSize >= 2);
  const valid = name.trim().length > 0 && (kind === 'blank' || carouselValid);

  const create = async () => {
    setBusy(true);
    try {
      if (kind === 'blank') {
        const t = await createTable(name);
        notify('success', `Table “${t.name}” created.`);
        onCreated(t.id);
      } else {
        const t = await createCarouselTable(name, { source, linkField, groupSize, closingAsset: closing || undefined });
        const tail = closing ? ` Each ends with the closing image (slide ${groupSize}).` : '';
        notify('success', `Carousel table “${t.name}” created: one record per carousel of up to ${groupSize} slides.${tail}`);
        onCreated(t.id);
      }
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="New table" onClose={onClose} size="mid" foot={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!valid || busy} onClick={() => void create()}>{kind === 'blank' ? 'Create table' : 'Create carousel table'}</button>
    </>}>
      <label className="fld"><span>Table name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Products, Carousels" autoFocus aria-label="Table name" />
      </label>
      <div className="fld"><span>Kind of table</span>
        <div className="col" role="radiogroup" aria-label="Table kind" style={{ gap: 6 }}>
          <label className="chk"><input type="radio" name="tkind" checked={kind === 'blank'} onChange={() => setKind('blank')} /> <b>Blank table</b> — a table that starts with a Name field</label>
          <label className="chk"><input type="radio" name="tkind" checked={kind === 'carousel'} onChange={() => setKind('carousel')} /> <b>Carousel table</b> — one record per carousel (a group of consecutive images)</label>
        </div>
      </div>
      {kind === 'carousel' && (
        <div className="col" style={{ gap: 10 }}>
          <label className="fld"><span>Source table — the table that holds the images</span>
            <select aria-label="Source table" value={source} onChange={(e) => { setSource(e.target.value); setLinkField(''); }}>
              <option value="">— choose —</option>
              {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="fld"><span>Image link field — the field with each image's URL</span>
            <select aria-label="Image link field" value={linkField} onChange={(e) => setLinkField(e.target.value)} disabled={!source}>
              <option value="">— choose —</option>
              {sourceFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </label>
          {source && sourceFields.length === 0 && <div className="callout warn">That table has no text or URL field yet. Add one (for example “Uploaded link”), then come back.</div>}
          <div className="fld"><span>Images per carousel</span>
            <div className="row wrap" role="radiogroup" aria-label="Images per carousel">
              {PRESETS.map((n) => (
                <label key={n} className="chk"><input type="radio" name="grp" aria-label={`Up to ${n} images`} checked={preset === n} onChange={() => setPreset(n)} /> 1–{n}</label>
              ))}
              <label className="chk"><input type="radio" name="grp" aria-label="Custom number of images" checked={preset === 'custom'} onChange={() => setPreset('custom')} /> custom</label>
              {preset === 'custom' && <input type="number" min={1} max={MAX_GROUP} aria-label="Custom images per carousel" value={custom} onChange={(e) => setCustom(Number(e.target.value))} style={{ width: 80 }} />}
            </div>
            <div className="small muted">Consecutive images make one carousel: with 100 images and 10 per carousel there are 10 carousel records, the last one may hold fewer.</div>
          </div>
          <label className="fld"><span>Closing slide — the last slide of every carousel (optional)</span>
            <select aria-label="Closing image" value={closing} onChange={(e) => setClosing(e.target.value)}>
              <option value="">None: every slide is an image from the table</option>
              {addressed.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <div className="small muted">
            {addressed.length === 0
              ? 'No image in Assets has a public address yet. Open Assets, pick an image (for example a call-to-action design) and give it a public address.'
              : closing
                ? `With ${groupSize} slides per carousel, slides 1–${groupSize - 1} are images from the table and slide ${groupSize} is the closing image, in every carousel.`
                : 'Pick an image from Assets (it needs a public address, which Buffer sends). Every carousel then ends with it.'}
          </div>
        </div>
      )}
    </Dialog>
  );
}
