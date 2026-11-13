import { db, getSetting } from '../db/schema';
import { httpKind } from './http';
import { pollWebsite } from './website';

let busy = false;

/** Checks every website connection once. A connection that fails does not stop the others. */
export async function pollAllWebsites(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (!(await getSetting<boolean>('automations.running', true))) return;
    const conns = await db.connections.where('provider').equals('http').toArray();
    for (const c of conns) {
      try { if ((await httpKind(c)) === 'website') await pollWebsite(c); } catch { /* keep going with the next connection */ }
    }
  } finally {
    busy = false;
  }
}

/** Checks the websites every minute while DCE is open (and once shortly after start-up). Returns the stop function. */
export function startConnectorLoop(): () => void {
  const iv = window.setInterval(() => void pollAllWebsites(), 60_000);
  const t = window.setTimeout(() => void pollAllWebsites(), 8000);
  return () => { clearInterval(iv); clearTimeout(t); };
}
