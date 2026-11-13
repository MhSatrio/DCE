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

export function AssetPicker(props: { current?: string; onPick: (id: string) => void; onClose: () => void; allowClear?: boolean }) {
  const [q, setQ] = useState('');
  const rows = useLiveQuery(() => db.assets.orderBy('name').toArray(), [], []);
  const list = (rows ?? []).filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()) || a.tags.some((t) => t.toLowerCase().includes(q.toLowerCase())));
  return (
    <Dialog title="Choose an image asset" onClose={props.onClose} size="wide" foot={<>
      {props.allowClear && <button className="btn" onClick={() => { props.onPick(''); props.onClose(); }}>Clear</button>}
      <button className="btn" onClick={props.onClose}>Cancel</button>
    </>}>
      <input type="search" placeholder="Search by name or tag" aria-label="Search assets" value={q} onChange={(e) => setQ(e.target.value)} />
      {list.length === 0 ? <div className="muted">No assets yet — upload some on the Assets page.</div> : (
        <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
          {list.map((a) => <Tile key={a.id} id={a.id} name={a.name} blob={a.thumb} selected={a.id === props.current} onPick={(id) => { props.onPick(id); props.onClose(); }} />)}
        </div>
      )}
    </Dialog>
  );
}
