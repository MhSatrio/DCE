import { useEffect, useState } from 'react';
import { Square } from 'lucide-react';
import { useStore } from '../ui/store';
import { runStore, stopPipelineRun } from './run';

/** A clock that re-renders once a second (for "running for 12 s" labels). */
export function useClock(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** 42 → "42s", 125 000 → "2m 05s". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Shown at the top of every page while a run is going, so a run is never invisible or impossible to stop. */
export function PipelineRunBanner({ hidden = false }: { hidden?: boolean }) {
  const active = useStore(runStore, (s) => s.active);
  const now = useClock(1000);
  if (!active || hidden) return null;
  return (
    <div className="run-banner" role="status" aria-label="Content pipeline running">
      <span className="run-dot" aria-hidden="true" />
      <a href="#/pipeline" className="grow run-banner-text">
        <b>Content pipeline running</b> — {active.stopping ? 'stopping…' : active.stage} <span className="muted">({elapsed(now - active.startedAt)})</span>
      </a>
      <button className="btn sm danger solid" onClick={() => stopPipelineRun()} disabled={active.stopping}><Square size={12} /> {active.stopping ? 'Stopping…' : 'Stop run'}</button>
    </div>
  );
}
