import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Archive, Download, History, Pause, Play, RefreshCw, Square, Trash2, TriangleAlert } from 'lucide-react';
import { BatchRun, defaultConcurrency, foldRetryIntoParent, type RunState } from '../batch/runner';
import { exportBundle } from '../batch/bundle';
import { allFields } from '../db/fields';
import { activeConditions, queryRecords, type FilterGroup } from '../db/filter';
import { recordsStore, renderDataFor } from '../db/repo';
import { defaultBatchConfig } from '../db/seed';
import { db, getSetting, setSetting, type BatchConfig, type ContentRecord, type JobRow } from '../db/schema';
import { renderFilename } from '../engine/binding';
import type { Issue } from '../engine/types';
import { Dialog, download, Empty, fmtBytes, fmtDate, fmtDuration, go, IconBtn } from '../ui/kit';
import { FilterBuilder } from '../ui/FilterBuilder';
import { Preview } from '../ui/Preview';
import { confirmAction, notify, useStore } from '../ui/store';
import { VirtualGrid, type GridCol } from '../ui/VirtualGrid';

const FORMATS: { id: BatchConfig['format']; label: string }[] = [
  { id: 'png', label: 'PNG' }, { id: 'jpeg', label: 'JPEG' }, { id: 'svg', label: 'SVG' }, { id: 'pdf', label: 'PDF' }, { id: 'html', label: 'HTML' },
];

function useRunState(run: BatchRun | null): RunState | null {
  return useSyncExternalStore(
    (fn) => (run ? run.store.subscribe(fn) : () => undefined),
    () => (run ? run.store.get() : null),
  );
}

const statusChip = (s: string) => {
  const cls = s === 'completed' ? 'ok' : s === 'completed_with_errors' ? 'warn' : s === 'failed' || s === 'interrupted' ? 'err' : s === 'cancelled' ? '' : 'blue';
  return <span className={`chip ${cls}`}>{s.replace(/_/g, ' ')}</span>;
};

function JobDialog({ job, onClose, onRetry }: { job: JobRow; onClose: () => void; onRetry: (j: JobRow) => void }) {
  const live = useLiveQuery(() => db.jobs.get(job.id), [job.id], job);
  const j = live ?? job;
  return (
    <Dialog title={`Job — ${j.templateName}`} onClose={onClose} size="mid" foot={<>
      <button className="btn" onClick={onClose}>Close</button>
      <button className="btn primary" disabled={j.failures.length === 0} onClick={() => { onClose(); onRetry(j); }}><RefreshCw size={14} /> Retry {j.failures.length} failed</button>
    </>}>
      <div className="row wrap">{statusChip(j.status)}<span className="chip ok">{j.success} ok</span><span className={`chip ${j.failure ? 'err' : ''}`}>{j.failure} failed</span><span className="muted small">{fmtDate(j.started_at)} · {fmtDuration(j.elapsedMs)} · {j.throughput}/s · {j.format.toUpperCase()}</span></div>
      <div className="small muted">Selection: {j.selectionLabel}</div>
      {j.failures.length === 0 ? <div className="callout">No failed records.</div> : (
        <>
          <div className="callout warn">Fix the cause — edit the record in the Content Plan or the template in the editor — then retry only the failed records. Retries use the <b>current</b> data and template.</div>
          <div style={{ maxHeight: '45vh', overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Record</th><th>Error</th></tr></thead>
              <tbody>{j.failures.map((f) => <tr key={f.recordId}><td style={{ whiteSpace: 'nowrap' }}><a href={`#/content/${f.recordId}`} onClick={onClose}>{f.title || f.recordId.slice(0, 8)}</a></td><td>{f.error}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="row"><button className="btn sm" onClick={() => go(`#/editor/${j.templateId}`)}>Open template</button></div>
        </>
      )}
    </Dialog>
  );
}

export default function BatchPage() {
  const records = useStore(recordsStore, (s) => s.records);
  const customFields = useStore(recordsStore, (s) => s.fields);
  const fields = useMemo(() => allFields(customFields), [customFields]);
  const templates = useLiveQuery(() => db.templates.orderBy('name').toArray(), [], []);
  const jobs = useLiveQuery(() => db.jobs.orderBy('started_at').reverse().limit(50).toArray(), [], []);
  const [cfg, setCfg] = useState<BatchConfig | null>(null);
  const [matched, setMatched] = useState<ContentRecord[]>([]);
  const [usedIndex, setUsedIndex] = useState<string | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [prevIdx, setPrevIdx] = useState(0);
  const [issues, setIssues] = useState<{ list: Issue[]; ms: number } | null>(null);
  const [run, setRun] = useState<BatchRun | null>(null);
  const [saveToDisk, setSaveToDisk] = useState(false);
  const [jobView, setJobView] = useState<JobRow | null>(null);
  const [busyBundle, setBusyBundle] = useState(false);
  const loaded = useRef(false);
  const rs = useRunState(run);
  const fsa = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

  // restore saved configuration once
  useEffect(() => {
    void (async () => {
      const saved = await getSetting<BatchConfig | null>('batch.config', null);
      const tpl = await db.templates.toCollection().first();
      const base = saved ?? defaultBatchConfig(tpl?.id ?? '');
      if (!base.templateId && tpl) base.templateId = tpl.id;
      setCfg(base); loaded.current = true;
    })();
  }, []);
  useEffect(() => { if (cfg && loaded.current) void setSetting('batch.config', cfg); }, [cfg]);

  const tpl = (templates ?? []).find((t) => t.id === cfg?.templateId);
  const patch = (p: Partial<BatchConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));

  // indexed query when the filter or the data changes
  const filterKey = JSON.stringify(cfg?.filter);
  useEffect(() => {
    if (!cfg) return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await queryRecords(cfg.filter as FilterGroup);
      if (!live) return;
      r.records.sort((a, b) => a.created_at - b.created_at);
      setMatched(r.records); setUsedIndex(r.usedIndex);
    }, 80);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, records]);

  const chosen = useMemo(() => {
    if (!cfg) return [];
    switch (cfg.selection) {
      case 'selected': return matched.filter((r) => pick.has(r.id));
      case 'individual': return matched.filter((r) => pick.has(r.id)).slice(0, 1);
      case 'range': {
        const a = Math.max(1, cfg.rangeFrom ?? 1), b = Math.min(matched.length, cfg.rangeTo ?? matched.length);
        return matched.slice(a - 1, Math.max(a - 1, b));
      }
      default: return matched;
    }
  }, [cfg, matched, pick]);

  useEffect(() => { setPrevIdx((i) => Math.min(i, Math.max(0, chosen.length - 1))); }, [chosen.length]);
  const previewRec = chosen[prevIdx];

  const selectionLabel = !cfg ? '' : cfg.selection === 'filtered' ? `All filtered (${matched.length})` : cfg.selection === 'range' ? `Range ${cfg.rangeFrom ?? 1}–${cfg.rangeTo ?? matched.length} of ${matched.length}` : cfg.selection === 'selected' ? `${chosen.length} selected` : 'Single record';

  const running = !!rs && (rs.status === 'running' || rs.status === 'paused' || rs.status === 'preparing');
  const fileExt = cfg ? (cfg.format === 'jpeg' ? 'jpg' : cfg.format) : 'png';
  const exampleName = cfg && previewRec && tpl ? renderFilename(cfg.filenamePattern || '{{content.slug}}', renderDataFor(previewRec, tpl.doc, prevIdx + 1, chosen.length), fileExt) : '—';

  const start = async (records2: ContentRecord[], label: string, parentId?: string) => {
    if (!cfg || !tpl) return;
    if (records2.length === 0) { notify('warn', 'Nothing to render — adjust the filter or selection.'); return; }
    let handle: FileSystemFileHandle | undefined;
    if (saveToDisk && fsa) {
      try {
        handle = await (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({ suggestedName: `${tpl.name.replace(/\W+/g, '-').toLowerCase()}.zip`, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] });
      } catch { return; /* user cancelled the picker */ }
    }
    const r = new BatchRun({ config: { ...cfg, concurrency: cfg.concurrency || defaultConcurrency() }, doc: tpl.doc, templateName: tpl.name, records: records2, selectionLabel: label, parentId, fileHandle: handle });
    setRun(r);
    void r.start();
    void r.done.then(() => {
      const s = r.store.get();
      if (parentId) void foldRetryIntoParent(parentId, r);
      if (s.status === 'completed') notify('success', `Batch complete: ${s.ok} file${s.ok === 1 ? '' : 's'} in ${fmtDuration(s.activeMs)}.`);
      else if (s.status === 'completed_with_errors') notify('warn', `Batch finished with ${s.failed} failed record${s.failed === 1 ? '' : 's'}. Open the job to inspect and retry.`);
      else if (s.status === 'cancelled') notify('info', 'Batch cancelled. A partial archive is available.');
      else notify('error', s.error ?? 'Batch failed.');
    });
  };

  const retry = async (job: JobRow) => {
    const tplRow = await db.templates.get(job.templateId);
    if (!tplRow) { notify('error', 'The template of this job no longer exists.'); return; }
    const ids = job.failures.map((f) => f.recordId);
    const recs = (await db.records.bulkGet(ids)).filter((r): r is ContentRecord => !!r);
    if (recs.length < ids.length) notify('warn', `${ids.length - recs.length} failed record(s) were deleted and are skipped.`);
    if (!recs.length) return;
    if (!cfg) return;
    const r = new BatchRun({ config: { ...job.config, concurrency: job.config.concurrency || defaultConcurrency() }, doc: tplRow.doc, templateName: tplRow.name, records: recs, selectionLabel: `Retry of ${fmtDate(job.started_at)}`, parentId: job.id });
    setRun(r); void r.start();
    void r.done.then(() => { void foldRetryIntoParent(job.id, r); const s = r.store.get(); notify(s.failed ? 'warn' : 'success', `Retry finished: ${s.ok} succeeded, ${s.failed} still failing.`); });
  };

  const setSize = (w: number, h: number) => patch({ outW: w, outH: h });
  const gridCols: GridCol[] = [{ key: 'title', title: 'Title', width: 260, sortable: false }, { key: 'status', title: 'Status', width: 100, sortable: false }, { key: 'publish_date', title: 'Publish date', width: 110, sortable: false }];

  if (!cfg) return <div className="page"><div className="muted">Loading…</div></div>;
  const pct = rs && rs.total ? Math.round((rs.done / rs.total) * 100) : 0;

  return (
    <div className="page" style={{ overflow: 'auto' }}>
      <div className="page-head"><h1>Batch Runner</h1><span className="muted">Render a template for many records and download a ZIP.</span></div>
      {(templates?.length ?? 0) === 0 && <Empty title="No templates yet"><a href="#/templates">Create a template first</a></Empty>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px, 1fr) minmax(360px, 440px)', gap: 12, alignItems: 'start' }}>
        <div className="col" style={{ gap: 12 }}>
          <section className="panel">
            <div className="panel-head"><h2>1 · Source &amp; template</h2></div>
            <div className="panel-body col">
              <div className="grid2">
                <label className="fld"><span>Database</span><select value="content_plan" onChange={() => undefined} aria-label="Source database"><option value="content_plan">Content Plan ({records.length.toLocaleString()} records)</option></select></label>
                <label className="fld"><span>Template</span>
                  <select value={cfg.templateId} onChange={(e) => { const t = templates?.find((x) => x.id === e.target.value); patch({ templateId: e.target.value, ...(t ? { outW: t.width, outH: t.height } : {}) }); }} aria-label="Template">
                    {(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.width}×{t.height})</option>)}
                  </select>
                </label>
              </div>
              <div className="small muted">Filter {usedIndex ? <span className="chip blue">uses index “{usedIndex}”</span> : activeConditions(cfg.filter as FilterGroup).length ? <span className="chip">in-memory scan</span> : null}</div>
              <FilterBuilder value={cfg.filter as FilterGroup} onChange={(g) => patch({ filter: g })} fields={fields} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>2 · Records</h2><span className="chip blue">{matched.length.toLocaleString()} match</span><span className="chip ok">{chosen.length.toLocaleString()} to render</span></div>
            <div className="panel-body col">
              <div className="seg" role="group" aria-label="Record selection">
                {([['filtered', 'All filtered'], ['selected', 'Selected'], ['range', 'Range'], ['individual', 'Single record']] as const).map(([id, label]) => (
                  <button key={id} className={cfg.selection === id ? 'on' : ''} onClick={() => patch({ selection: id })}>{label}</button>
                ))}
              </div>
              {cfg.selection === 'range' && (
                <div className="row">Records <input type="number" min={1} aria-label="Range from" style={{ width: 90 }} value={cfg.rangeFrom ?? 1} onChange={(e) => patch({ rangeFrom: Number(e.target.value) })} /> to <input type="number" min={1} aria-label="Range to" style={{ width: 90 }} value={cfg.rangeTo ?? matched.length} onChange={(e) => patch({ rangeTo: Number(e.target.value) })} /> <span className="muted small">of {matched.length} (oldest first)</span></div>
              )}
              {(cfg.selection === 'selected' || cfg.selection === 'individual') && (
                <>
                  <div className="row small">
                    {cfg.selection === 'selected' && <><button className="btn sm" onClick={() => setPick(new Set(matched.map((r) => r.id)))}>Select all {matched.length}</button><button className="btn sm" onClick={() => setPick(new Set())}>Clear</button></>}
                    <span className="muted">{pick.size} picked</span>
                  </div>
                  <div style={{ height: 260, display: 'flex' }} className="vgrid">
                    <VirtualGrid
                      rows={matched} rowId={(r) => r.id} cols={gridCols} sort={null} onSort={() => undefined} onResize={() => undefined} rowHeight={30}
                      selected={pick} onToggleAll={(all) => setPick(all ? new Set(matched.map((r) => r.id)) : new Set())}
                      onToggleSelect={(id) => setPick((p) => { const n = cfg.selection === 'individual' ? new Set<string>() : new Set(p); if (p.has(id)) n.delete(id); else n.add(id); return n; })}
                      renderCell={(r, c) => <span className="txt">{String((r as unknown as Record<string, unknown>)[c.key] ?? '')}</span>}
                    />
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>3 · Output</h2></div>
            <div className="panel-body col">
              <div className="row wrap">
                <div className="seg" role="group" aria-label="Output format">
                  {FORMATS.map((f) => <button key={f.id} className={cfg.format === f.id ? 'on' : ''} onClick={() => patch({ format: f.id, filenamePattern: cfg.filenamePattern.replace(/\.(png|jpe?g|svg|pdf|html)$/i, '') + '.' + (f.id === 'jpeg' ? 'jpg' : f.id) })}>{f.label}</button>)}
                </div>
                {cfg.format === 'jpeg' && <label className="row small">Quality <input type="range" min={0.4} max={1} step={0.02} value={cfg.quality} onChange={(e) => patch({ quality: Number(e.target.value) })} aria-label="JPEG quality" /> {Math.round(cfg.quality * 100)}</label>}
                {cfg.format === 'png' && <label className="chk small"><input type="checkbox" checked={cfg.transparent} onChange={(e) => patch({ transparent: e.target.checked })} /> Transparent background</label>}
                {cfg.format === 'pdf' && <div className="seg" role="group" aria-label="PDF mode"><button className={cfg.pdfMode === 'separate' ? 'on' : ''} onClick={() => patch({ pdfMode: 'separate' })}>One PDF per record</button><button className={cfg.pdfMode === 'combined' ? 'on' : ''} onClick={() => patch({ pdfMode: 'combined' })}>Single multi-page PDF</button></div>}
              </div>
              <div className="row wrap">
                <label className="fld"><span>Width (px)</span><input type="number" min={16} max={8192} style={{ width: 100 }} value={cfg.outW} onChange={(e) => tpl ? setSize(Number(e.target.value), Math.round(Number(e.target.value) * tpl.height / tpl.width)) : patch({ outW: Number(e.target.value) })} /></label>
                <label className="fld"><span>Height (px)</span><input type="number" min={16} max={8192} style={{ width: 100 }} value={cfg.outH} onChange={(e) => patch({ outH: Number(e.target.value) })} /></label>
                {tpl && <button className="btn sm" onClick={() => setSize(tpl.width, tpl.height)}>Template size</button>}
                {tpl && <button className="btn sm" onClick={() => setSize(tpl.width * 2, tpl.height * 2)}>2×</button>}
                {(cfg.format === 'svg' || cfg.format === 'html') && <span className="muted small">Vector formats scale freely; size sets the document size.</span>}
              </div>
              <label className="fld"><span>File name pattern — e.g. {'{{content.slug}}'}, {'{{index:4}}-{{content.title|slug}}'}</span><input value={cfg.filenamePattern} onChange={(e) => patch({ filenamePattern: e.target.value })} aria-label="Filename pattern" /></label>
              <div className="small muted">First file: <code>{exampleName}</code>{cfg.format === 'pdf' && cfg.pdfMode === 'combined' ? ' (combined mode writes one PDF named after the template)' : ''}</div>
              <div className="row wrap small">
                <label className="chk"><input type="checkbox" checked={cfg.includeManifest} onChange={(e) => patch({ includeManifest: e.target.checked })} /> Include manifest.json</label>
                <label className="row">Workers <select value={cfg.concurrency} onChange={(e) => patch({ concurrency: Number(e.target.value) })} aria-label="Worker count"><option value={0}>Auto ({defaultConcurrency()})</option>{[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
                {fsa && <label className="chk"><input type="checkbox" checked={saveToDisk} onChange={(e) => setSaveToDisk(e.target.checked)} /> Stream ZIP straight to disk (large batches)</label>}
              </div>
            </div>
          </section>
        </div>

        <div className="col" style={{ gap: 12, position: 'sticky', top: 0 }}>
          <section className="panel">
            <div className="panel-head"><h2>Sample preview</h2><span className="grow" />
              <button className="btn sm" disabled={prevIdx <= 0} onClick={() => setPrevIdx(prevIdx - 1)} aria-label="Previous record">‹</button>
              <span className="small muted">{chosen.length ? prevIdx + 1 : 0} / {chosen.length}</span>
              <button className="btn sm" disabled={prevIdx >= chosen.length - 1} onClick={() => setPrevIdx(prevIdx + 1)} aria-label="Next record">›</button>
            </div>
            <div className="panel-body col">
              {tpl && previewRec ? <Preview doc={tpl.doc} record={previewRec} width={400} onIssues={(l, ms) => setIssues({ list: l, ms })} /> : <div className="muted">Pick a template and at least one record to preview.</div>}
              {previewRec && <div className="small"><b>{previewRec.title}</b>{issues && <span className="muted"> · rendered in {Math.round(issues.ms)} ms</span>}</div>}
              {issues && issues.list.length > 0 && (
                <div className={`callout ${issues.list.some((i) => i.level === 'error') ? 'err' : 'warn'}`} style={{ maxHeight: 120, overflow: 'auto' }}>
                  {issues.list.map((i, k) => <div key={k}><TriangleAlert size={12} /> {i.nodeName ? <b>{i.nodeName}: </b> : null}{i.message}</div>)}
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>4 · Render</h2></div>
            <div className="panel-body col">
              {!running ? (
                <>
                  <button className="btn primary" style={{ height: 38, fontSize: 15 }} disabled={!tpl || chosen.length === 0} onClick={() => start(chosen, selectionLabel)}><Play size={16} /> Start rendering {chosen.length.toLocaleString()} record{chosen.length === 1 ? '' : 's'}</button>
                  <button className="btn" disabled={!tpl || chosen.length === 0 || busyBundle} onClick={async () => { if (!tpl) return; setBusyBundle(true); try { const n = await exportBundle(tpl, chosen); notify('success', `Bundle with ${n} record${n === 1 ? '' : 's'} exported. See README.md inside.`); } catch (e) { notify('error', `Bundle failed: ${e instanceof Error ? e.message : String(e)}`); } setBusyBundle(false); }}><Archive size={15} /> Export external render bundle (Python)</button>
                </>
              ) : (
                <div className="row">
                  {rs!.status === 'paused' ? <button className="btn primary" onClick={() => run!.resume()}><Play size={15} /> Resume</button> : <button className="btn" onClick={() => run!.pause()} disabled={rs!.status === 'preparing'}><Pause size={15} /> Pause</button>}
                  <button className="btn danger" onClick={async () => { if (await confirmAction('Cancel this batch?', 'Records already rendered stay in a partial ZIP you can download.', 'Cancel batch')) run!.cancel(); }}><Square size={14} /> Cancel</button>
                </div>
              )}
              {rs && (
                <div className="col" aria-live="polite">
                  <div className={`progress ${rs.failed ? 'bad' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${pct}%` }} /></div>
                  <div className="row wrap small">
                    <b>{pct}%</b><span>{rs.done.toLocaleString()} / {rs.total.toLocaleString()}</span>
                    <span className="chip ok">{rs.ok} ok</span><span className={`chip ${rs.failed ? 'err' : ''}`}>{rs.failed} failed</span>{rs.warnings > 0 && <span className="chip warn">{rs.warnings} with warnings</span>}
                    {statusChip(rs.status === 'preparing' ? 'running' : rs.status)}
                  </div>
                  <div className="small muted">{running && rs.current ? <>Current: <b style={{ color: 'var(--ink)' }}>{rs.current}</b> · </> : null}elapsed {fmtDuration(rs.activeMs)}{rs.etaMs !== null && running ? ` · about ${fmtDuration(rs.etaMs)} left` : ''} · {rs.throughput.toFixed(1)} records/s · {fmtBytes(rs.bytesOut)} rendered</div>
                  {rs.error && <div className="callout err">{rs.error}</div>}
                  {!running && rs.output && <button className="btn primary" onClick={() => download(rs.output!.blob, rs.output!.name)}><Download size={15} /> Download {rs.output.name} ({fmtBytes(rs.output.blob.size)})</button>}
                  {!running && !rs.output && rs.status !== 'preparing' && rs.done > 0 && !rs.error && <div className="callout">The ZIP was streamed to the file you chose.</div>}
                  {!running && rs.failed > 0 && <div className="row"><button className="btn" onClick={() => setJobView(run!.job)}>Inspect {rs.failed} failed</button><button className="btn" onClick={() => void retry({ ...run!.job, failures: rs.failures, failure: rs.failed })}><RefreshCw size={14} /> Retry failed</button></div>}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><History size={16} /><h2>Batch history</h2><span className="muted small">Generated files are not stored in the database — download the ZIP when a job completes.</span></div>
        {(jobs?.length ?? 0) === 0 ? <div className="empty">No batch jobs yet.</div> : (
          <table className="tbl">
            <thead><tr><th>Started</th><th>Template</th><th>Selection</th><th>Format</th><th>Status</th><th>Records</th><th>Time</th><th>Errors</th><th /></tr></thead>
            <tbody>
              {jobs!.map((j) => (
                <tr key={j.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(j.started_at)}{j.parentId && <span className="chip" style={{ marginLeft: 4 }}>retry</span>}</td>
                  <td>{j.templateName}</td><td className="small">{j.selectionLabel}</td><td>{j.format.toUpperCase()}</td><td>{statusChip(j.status)}</td>
                  <td className="small"><span style={{ color: 'var(--ok)' }}>{j.success}</span> / <span style={{ color: j.failure ? 'var(--danger)' : undefined }}>{j.failure}</span> of {j.total}</td>
                  <td className="small">{fmtDuration(j.elapsedMs)} <span className="muted">({j.throughput}/s)</span></td>
                  <td className="small" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.errorSummary}>{j.errorSummary || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={() => setJobView(j)}>Inspect</button>
                    <IconBtn icon={<Trash2 size={14} />} label="Delete job record" onClick={async () => { if (await confirmAction('Delete this history entry?', 'Only the log entry is removed.')) await db.jobs.delete(j.id); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {jobView && <JobDialog job={jobView} onClose={() => setJobView(null)} onRetry={(j) => void retry(j)} />}
    </div>
  );
}
