import { createStore } from '../ui/store';
import { CONTENT_TABLE, DEFAULT_CONTENT_NAME } from './constants';
import type { ContentRecord, FieldDef, TableDef } from './schema';

/** In-memory mirrors of IndexedDB used by the grids. The Content Plan keeps its own store (it predates custom tables). */
export const recordsStore = createStore<{ records: ContentRecord[]; loaded: boolean; fields: FieldDef[] }>({
  records: [], loaded: false, fields: [],
});

export const tablesStore = createStore<{
  tables: TableDef[];
  rows: Record<string, ContentRecord[]>;
  fields: Record<string, FieldDef[]>;
  /** The Content Plan's current name (renamed through Settings or the table header). */
  contentName: string;
  loaded: boolean;
}>({ tables: [], rows: {}, fields: {}, contentName: DEFAULT_CONTENT_NAME, loaded: false });

export { CONTENT_TABLE };
/** Kept for code that needs the starting name; use tableName(CONTENT_TABLE) for the current one. */
export const CONTENT_NAME = DEFAULT_CONTENT_NAME;
