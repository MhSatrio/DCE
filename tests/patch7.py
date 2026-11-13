def sub(p, old, new):
    s = open(p, encoding='utf-8').read()
    assert old in s, (p, old[:70])
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(s)

S = 'src/db/schema.ts'
sub(S, """export type FieldType =
  | 'text' | 'longtext' | 'number' | 'boolean' | 'date' | 'select' | 'multiselect'
  | 'url' | 'image' | 'relation' | 'markdown' | 'json';""", """export type FieldType =
  | 'text' | 'longtext' | 'number' | 'boolean' | 'date' | 'select' | 'multiselect'
  | 'url' | 'image' | 'relation' | 'markdown' | 'json'
  | 'email' | 'phone' | 'currency' | 'percent' | 'rating' | 'datetime'
  | 'link' | 'createdTime' | 'modifiedTime' | 'autonumber';""")
sub(S, "  relationTo?: 'templates' | 'assets' | 'records';\n  order: number;\n}", """  relationTo?: 'templates' | 'assets' | 'records';
  order: number;
  /** Which table the field belongs to; undefined = the Content Plan. */
  tableId?: string;
  /** type 'link': the table whose records this field points to, and the matching field on that side. */
  linkTable?: string;
  inverseKey?: string;
  /**
   * Synced field: a live mirror of `source` (a field of the linked table) reached through the link field `via`.
   * `type` is the source's type, so the grid, filters, exports and template bindings treat it like any other field.
   */
  sync?: { via: string; source: string };
  currency?: string;    // symbol for 'currency', e.g. "$", "Rp"
  ratingMax?: number;   // 'rating'
}

export interface TableDef { id: string; name: string; created_at: number }

export interface ConnectionProp { id: string; key: string; secret: boolean; value?: string; enc?: string }
export interface ConnectionRow {
  id: string;
  provider: 'buffer' | 'custom';
  name: string;
  created_at: number;
  props: ConnectionProp[];
}

export interface AutomationConfig {
  channel: string;               // property key on the connection, e.g. BUFFER_CHANNEL_ID_INSTAGRAM
  text: string;                  // template, e.g. "{{title}} — {{description}}"
  imageField?: string;           // field holding a PUBLIC image URL
  mode: 'queue' | 'delay' | 'field';
  delayAmount: number;
  delayUnit: 'minutes' | 'hours' | 'days';
  timeField?: string;            // date / datetime field (mode 'field')
  pastPolicy: 'skip' | 'queue';  // what to do when the chosen time has already passed
  setField?: string;             // after a successful send…
  setValue?: string;             // …set this field to this value (e.g. Status = Posted)
  resultField?: string;          // …and store the Buffer post id here
}

export interface AutomationRow {
  id: string;
  name: string;
  table: string;
  enabled: boolean;
  created_at: number;
  filter: { join: 'and' | 'or'; conditions: { id: string; field: string; op: string; value: string }[] };
  connectionId: string;          // '' = the active Buffer account
  action: AutomationConfig;
  /** record id → { at: when it fired, n: failed attempts, last: last attempt } */
  fired: Record<string, { at: number; n: number; last: number; done: boolean }>;
}

export interface AutoRunRow {
  id: string;
  automationId: string;
  automationName: string;
  recordId: string;
  recordTitle: string;
  at: number;
  status: 'sent' | 'failed' | 'dry' | 'skipped';
  detail: string;
  postId?: string;
  dueAt?: string;
}""")
sub(S, "  tags: string[];\n  created_at: number;\n  updated_at: number;\n  data: Record<string, unknown>;\n  sample?: boolean;", "  tags: string[];\n  created_at: number;\n  updated_at: number;\n  data: Record<string, unknown>;\n  /** Rows of custom tables carry their table id; Content Plan records leave it undefined. */\n  table?: string;\n  sample?: boolean;")
sub(S, "  settings!: Table<SettingRow, string>;", "  settings!: Table<SettingRow, string>;\n  tables!: Table<TableDef, string>;\n  rows!: Table<ContentRecord, string>;\n  connections!: Table<ConnectionRow, string>;\n  automations!: Table<AutomationRow, string>;\n  autoRuns!: Table<AutoRunRow, string>;")
sub(S, "      settings: 'key',\n    });\n  }", """      settings: 'key',
    });
    this.version(2).stores({
      records: 'id, title, slug, status, publish_date, template_ref, image_asset, created_at, updated_at, *tags',
      fields: 'id, key, order, tableId',
      templates: 'id, name, updated_at',
      assets: 'id, name, category, created_at, *tags',
      fonts: 'id, family',
      jobs: 'id, status, started_at',
      settings: 'key',
      tables: 'id, name, created_at',
      rows: 'id, table, created_at',
      connections: 'id, provider, created_at',
      automations: 'id, table, enabled',
      autoRuns: 'id, automationId, recordId, at',
    });
  }""")

# ---------------- fields.ts
F = 'src/db/fields.ts'
sub(F, """  select: 'Single select', multiselect: 'Multi-select', url: 'URL', image: 'Image', relation: 'Relation',
  markdown: 'Markdown', json: 'JSON',
};""", """  select: 'Single select', multiselect: 'Multi-select', url: 'URL', image: 'Image', relation: 'Template link',
  markdown: 'Markdown', json: 'JSON', email: 'Email', phone: 'Phone number', currency: 'Currency', percent: 'Percent',
  rating: 'Rating', datetime: 'Date & time', link: 'Link to another table', createdTime: 'Created time',
  modifiedTime: 'Last modified time', autonumber: 'Auto number',
};

/** Types whose value the app fills in itself. */
export const AUTO_TYPES: FieldType[] = ['createdTime', 'modifiedTime', 'autonumber'];""")
sub(F, "export function getValue(rec: ContentRecord, key: string): unknown {\n  if (key === 'created_at'", "export function getValue(rec: ContentRecord, key: string): unknown {\n  if (rec.table && rec.table !== 'content') {\n    if (key === 'id') return rec.id;\n    if (key === 'created_at' || key === 'updated_at') return new Date(rec[key] as number).toISOString();\n    return rec.data?.[key];\n  }\n  if (key === 'created_at'")
sub(F, "export function setValue(rec: ContentRecord, key: string, value: unknown): ContentRecord {\n  if (BUILTIN_KEYS.has(key)) {", "export function setValue(rec: ContentRecord, key: string, value: unknown): ContentRecord {\n  if (!rec.table || rec.table === 'content') if (BUILTIN_KEYS.has(key)) {")
# coerce
sub(F, "    case 'number': {\n      if (s === '') return { value: '' };\n      const n = Number(typeof s === 'string' ? s.replace(/,/g, '') : s);\n      return Number.isFinite(n) ? { value: n } : { value: '', error: `\"${String(raw)}\" is not a number` };\n    }",
"""    case 'number': case 'currency': case 'percent': {
      if (s === '') return { value: '' };
      const n = Number(typeof s === 'string' ? s.replace(/[,%\\s]|^[^\\d.+-]+/g, '') : s);
      return Number.isFinite(n) ? { value: n } : { value: '', error: `"${String(raw)}" is not a number` };
    }
    case 'rating': {
      if (s === '') return { value: 0 };
      const n = Math.round(Number(s));
      const max = f.ratingMax ?? 5;
      return Number.isFinite(n) && n >= 0 && n <= max ? { value: n } : { value: 0, error: `rating must be 0–${max}` };
    }
    case 'email':
      if (s !== '' && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(s))) return { value: String(s), error: `"${String(s)}" is not an email address` };
      return { value: String(s) };
    case 'phone':
      if (s !== '' && !/^[+()\\d\\s.-]{5,}$/.test(String(s))) return { value: String(s), error: `"${String(s)}" is not a phone number` };
      return { value: String(s) };
    case 'datetime': {
      if (s === '') return { value: '' };
      const str = String(s).trim().replace(' ', 'T');
      if (/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/.test(str) && !Number.isNaN(Date.parse(str))) return { value: str };
      const d = new Date(String(s));
      if (!Number.isNaN(d.getTime())) { const p = (n: number) => String(n).padStart(2, '0'); return { value: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }; }
      return { value: '', error: `"${String(s)}" is not a date and time` };
    }
    case 'link':
      return { value: Array.isArray(s) ? s.map(String) : String(s).split(/[;|]/).map((x) => x.trim()).filter(Boolean) };""")
sub(F, "export function displayValue(v: unknown): string {", "export function displayValue(v: unknown): string {\n  if (typeof v === 'number' && Number.isNaN(v)) return '';")
print('ok')
