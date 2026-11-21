import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import { Dialog } from './kit';
import { useBlobUrl } from './hooks';

function Tile({ id, name, blob, selected, onPick }: { id: string; name: string; blob: Blob; selected: boolean; onPick: (id: string) => void }) {
  const url = useBlobUrl(blob);
  return (
    <button className={`card ${selected ? 'sel' : ''}`} onClick={() => onPick(id)} onDoubleClick={() => onPick(id)} aria-label={`Choose ${name}`}>
      <div className="pic">{url && <img src={url} alt="" loading="lazy" />}</div>
      <div className="meta"><div className="name">{name}</div></div>
    </button>
  );
}

export interface PickableField { key: string; label: string; type: string }

/**
 * Chooses an uploaded image. When the element's table is known (`fields`), the dialog also offers a field of the record:
 * its value is read for every record, so a web address in it is downloaded when the batch runs.
 */
export function AssetPicker(props: {
  current?: string; onPick: (id: string) => void; onClose: () => void; allowClear?: boolean;
  fields?: PickableField[]; currentField?: string; onPickField?: (key: string) => void;
}) {
  const [q, setQ] = useState('');
  const hasFields = !!props.onPickField && (props.fields?.length ?? 0) > 0;
  const [tab, setTab] = useState<'assets' | 'fields'>(props.currentField && hasFields ? 'fields' : 'assets');
  const rows = useLiveQuery(() => db.assets.orderBy('name').toArray(), [], []);
  const list = (rows ?? []).filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()) || a.tags.some((t) => t.toLowerCase().includes(q.toLowerCase())));
  return (
    <Dialog title="Choose an image asset" onClose={props.onClose} size="wide" foot={<>
      {props.allowClear && <button className="btn" onClick={() => { props.onPick(''); props.onClose(); }}>Clear</button>}
      <button className="btn" onClick={props.onClose}>Cancel</button>
    </>}>
      {hasFields && (
        <div className="row" role="tablist" style={{ gap: 6, marginBottom: 10 }}>
          <button role="tab" aria-selected={tab === 'assets'} className={`btn ${tab === 'assets' ? 'primary' : ''}`} onClick={() => setTab('assets')}>Uploaded image</button>
          <button role="tab" aria-selected={tab === 'fields'} className={`btn ${tab === 'fields' ? 'primary' : ''}`} onClick={() => setTab('fields')}>From a record field</button>
        </div>
      )}
      {tab === 'fields' && hasFields ? (
        <div className="col" style={{ gap: 8 }}>
          <div className="small muted">
            The image is taken from this field of each record. A web address (https://…) is downloaded when the batch runs, or for the preview; a name or id of an uploaded image uses that image. A record without a value uses the static image or the fallback.
          </div>
          {props.fields!.map((f) => (
            <button key={f.key} className={`btn ${props.currentField === f.key ? 'primary' : ''}`} style={{ justifyContent: 'flex-start' }}
              aria-label={`Use the field ${f.label}`} onClick={() => { props.onPickField!(f.key); props.onClose(); }}>
              {f.label} <span className="muted small">{f.type}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <input type="search" placeholder="Search by name or tag" aria-label="Search assets" value={q} onChange={(e) => setQ(e.target.value)} />
          {list.length === 0 ? <div className="muted">No assets yet — upload some on the Assets page.</div> : (
            <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
              {list.map((a) => <Tile key={a.id} id={a.id} name={a.name} blob={a.thumb} selected={a.id === props.current} onPick={(id) => { props.onPick(id); props.onClose(); }} />)}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
