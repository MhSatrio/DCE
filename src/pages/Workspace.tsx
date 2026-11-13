import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRight, FileImage, Layers3, Play, Table2 } from 'lucide-react';
import { db } from '../db/schema';
import { recordsStore } from '../db/repo';
import { fmtDate, fmtDuration } from '../ui/kit';
import { useStore } from '../ui/store';

export default function Workspace() {
  const records = useStore(recordsStore, (s) => s.records);
  const counts = useLiveQuery(async () => ({ templates: await db.templates.count(), assets: await db.assets.count(), jobs: await db.jobs.count() }), [], { templates: 0, assets: 0, jobs: 0 });
  const recent = useLiveQuery(() => db.jobs.orderBy('started_at').reverse().limit(5).toArray(), [], []);
  const steps = [
    { n: 1, icon: Layers3, title: 'Design a template', text: 'Draw shapes, text and image frames once. Bind them to fields such as {{content.title}}.', to: '#/templates', cta: 'Open templates' },
    { n: 2, icon: Table2, title: 'Fill the Content Plan', text: 'Import CSV / JSON or type records. Add custom fields without touching code.', to: '#/content', cta: 'Open content plan' },
    { n: 3, icon: FileImage, title: 'Add image assets', text: 'Upload product images once; records link to them by id.', to: '#/assets', cta: 'Open assets' },
    { n: 4, icon: Play, title: 'Generate a batch', text: 'Filter, select, choose a format and download a ZIP of finished graphics.', to: '#/batch', cta: 'Open batch runner' },
  ];
  return (
    <div className="page" style={{ overflow: 'auto' }}>
      <div className="page-head"><h1>Workspace</h1><span className="muted">Design once. Connect data. Generate hundreds of assets.</span></div>
      <div className="row wrap">
        <div className="stat"><b>{records.length.toLocaleString()}</b><span>records</span></div>
        <div className="stat"><b>{counts?.templates}</b><span>templates</span></div>
        <div className="stat"><b>{counts?.assets}</b><span>image assets</span></div>
        <div className="stat"><b>{counts?.jobs}</b><span>batch jobs</span></div>
      </div>
      <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
        {steps.map((s) => {
          const Icon = s.icon;
          return (
            <a key={s.n} href={s.to} className="card" style={{ textDecoration: 'none', color: 'inherit', padding: 14, gap: 8 }}>
              <div className="row"><span className="chip blue">Step {s.n}</span><Icon size={18} color="var(--brand)" /></div>
              <h2>{s.title}</h2><div className="muted" style={{ flex: 1 }}>{s.text}</div>
              <div className="row" style={{ color: 'var(--brand)', fontWeight: 600 }}>{s.cta} <ArrowRight size={14} /></div>
            </a>
          );
        })}
      </div>
      <section className="panel">
        <div className="panel-head"><h2>Recent batch jobs</h2><span className="grow" /><a href="#/batch">Open batch runner</a></div>
        {(recent?.length ?? 0) === 0 ? <div className="empty">No jobs yet. The sample workspace is ready: open the Batch Runner and press Start.</div> : (
          <table className="tbl"><thead><tr><th>Started</th><th>Template</th><th>Format</th><th>Result</th><th>Time</th></tr></thead>
            <tbody>{recent!.map((j) => <tr key={j.id}><td>{fmtDate(j.started_at)}</td><td>{j.templateName}</td><td>{j.format.toUpperCase()}</td><td>{j.success} ok · {j.failure} failed</td><td>{fmtDuration(j.elapsedMs)} ({j.throughput}/s)</td></tr>)}</tbody></table>
        )}
      </section>
      <div className="muted small">Everything is stored locally in this browser (IndexedDB). Nothing is uploaded.</div>
    </div>
  );
}
