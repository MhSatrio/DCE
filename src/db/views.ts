import type { FilterGroup } from './filter';
import { getSetting, setSetting } from './schema';

/**
 * A saved view of a table: the search text, the filter, the sort and the hidden fields, under a name. Views belong to this browser
 * (they are kept in the app's settings, not in the table), so they do not change what other people or exports see.
 */
export interface SavedView {
  id: string;
  name: string;
  q: string;
  filter: FilterGroup;
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  hidden: string[];
  savedAt: number;
}

export const MAX_VIEWS = 30;
export const MAX_VIEW_NAME = 60;
export const viewsKey = (tableId: string) => `views.${tableId}`;

export const cleanViewName = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_VIEW_NAME);

/** Saves a view under its name: a view with the same name (any capitals) is replaced and keeps its place; a new one goes last. */
export function upsertView(list: SavedView[], v: Omit<SavedView, 'id' | 'savedAt'>, now = Date.now(), newId = () => 'v_' + Math.random().toString(36).slice(2, 10)): SavedView[] {
  const name = cleanViewName(v.name);
  if (!name) throw new Error('Give the view a name.');
  const at = list.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
  if (at < 0 && list.length >= MAX_VIEWS) throw new Error(`A table can have at most ${MAX_VIEWS} saved views. Delete one first.`);
  const next: SavedView = { ...structuredClone(v), name, id: at >= 0 ? list[at].id : newId(), savedAt: now };
  return at >= 0 ? list.map((x, i) => (i === at ? next : x)) : [...list, next];
}

export const removeView = (list: SavedView[], id: string): SavedView[] => list.filter((v) => v.id !== id);

/** True when the table's current state is exactly this view (so the screen can show which view is open). */
export function sameState(v: SavedView, cur: { q: string; filter: FilterGroup; sort: SavedView['sort']; hidden: string[] }): boolean {
  const norm = (x: unknown) => JSON.stringify(x);
  return v.q === cur.q && norm(v.filter) === norm(cur.filter) && norm(v.sort) === norm(cur.sort) && norm([...v.hidden].sort()) === norm([...cur.hidden].sort());
}

export async function loadViews(tableId: string): Promise<SavedView[]> {
  const raw = await getSetting<unknown>(viewsKey(tableId), []);
  return Array.isArray(raw) ? (raw as SavedView[]).filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string' && v.filter) : [];
}
export const saveViews = (tableId: string, list: SavedView[]) => setSetting(viewsKey(tableId), list);
