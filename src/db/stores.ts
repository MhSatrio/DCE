import { createStore } from '../ui/store';
import type { ContentRecord, FieldDef, TableDef } from './schema';

/** In-memory mirrors of IndexedDB used by the grids. The Content Plan keeps its own store (it predates custom tables). */
export const recordsStore = createStore<{ records: ContentRecord[]; loaded: boolean; fields: FieldDef[] }>({
  records: [], loaded: false, fields: [],
});

export const tablesStore = createStore<{
  tables: TableDef[];
  rows: Record<string, ContentRecord[]>;
  fields: Record<string, FieldDef[]>;
  loaded: boolean;
}>({ tables: [], rows: {}, fields: {}, loaded: false });

export const CONTENT_TABLE = 'content';
export const CONTENT_NAME = 'Content Plan';
