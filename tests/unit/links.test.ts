import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, isEncrypted, testKey } from '../../src/db/vault';
import { dependentsOf, propagate, type Snapshot } from '../../src/db/links';
import type { ContentRecord, FieldDef } from '../../src/db/schema';

const row = (table: string, id: string, data: Record<string, unknown> = {}): ContentRecord => ({
  id, title: '', slug: '', status: '', publish_date: '', content: '', image_asset: '', template_ref: '', tags: [], created_at: 1, updated_at: 1, data, table,
});
const f = (key: string, type: FieldDef['type'], extra: Partial<FieldDef> = {}): FieldDef => ({ id: key, key, label: key, type, order: 0, ...extra });

const make = (): Snapshot => ({
  a: { fields: [f('name', 'text'), f('bs', 'link', { linkTable: 'b', inverseKey: 'as' }), f('bprice', 'number', { sync: { via: 'bs', source: 'price' } })], records: [row('a', 'a1', { name: 'A1', bs: [] }), row('a', 'a2', { name: 'A2', bs: [] })] },
  b: { fields: [f('name', 'text'), f('price', 'number'), f('as', 'link', { linkTable: 'a', inverseKey: 'bs' })], records: [row('b', 'b1', { name: 'B1', price: 10, as: [] })] },
});

/** Applies a propagation result to the snapshot like the stores do. */
function apply(snap: Snapshot, t: string, recs: ContentRecord[], res: Map<string, ContentRecord[]>): Snapshot {
  const next: Snapshot = structuredClone(snap);
  const put = (tt: string, rs: ContentRecord[]) => { for (const r of rs) { const i = next[tt].records.findIndex((x) => x.id === r.id); if (i >= 0) next[tt].records[i] = r; else next[tt].records.push(r); } };
  put(t, recs);
  for (const [tt, rs] of res) put(tt, rs);
  return next;
}
/** What the stores do on a write: put the new versions in, then propagate on the updated snapshot. */
function change(snap: Snapshot, t: string, recs: ContentRecord[], opts: Parameters<typeof propagate>[3] = {}): Snapshot {
  const s2 = apply(snap, t, recs, new Map());
  return apply(s2, t, [], propagate(s2, t, recs, opts));
}
const get = (s: Snapshot, t: string, id: string) => s[t].records.find((r) => r.id === id)!;

describe('linked + synced fields across tables', () => {
  const link = (snap: Snapshot, aid: string, bid: string) => { const r = get(snap, 'a', aid); return change(snap, 'a', [{ ...r, data: { ...r.data, bs: [bid] } }]); };

  it('linking A→B also links B→A and mirrors the field', () => {
    const after = link(make(), 'a1', 'b1');
    expect(get(after, 'b', 'b1').data.as).toEqual(['a1']);
    expect(get(after, 'a', 'a1').data.bprice).toBe(10);
  });

  it('changing the source field in table B updates the synced copy in table A (and every record linking to it)', () => {
    let snap = link(link(make(), 'a1', 'b1'), 'a2', 'b1');
    expect(get(snap, 'a', 'a2').data.bprice).toBe(10);
    const b1 = get(snap, 'b', 'b1');
    snap = change(snap, 'b', [{ ...b1, data: { ...b1.data, price: 99 } }]);
    expect(get(snap, 'a', 'a1').data.bprice).toBe(99);
    expect(get(snap, 'a', 'a2').data.bprice).toBe(99);
  });

  it('editing the synced field in table A writes through to table B and on to the other mirrors', () => {
    let snap = link(link(make(), 'a1', 'b1'), 'a2', 'b1');
    const prev = get(snap, 'a', 'a1');
    snap = change(snap, 'a', [{ ...prev, data: { ...prev.data, bprice: 42 } }], { prev: new Map([['a1', prev]]) });
    expect(get(snap, 'b', 'b1').data.price).toBe(42);
    expect(get(snap, 'a', 'a2').data.bprice).toBe(42);
    expect(get(snap, 'a', 'a1').data.bprice).toBe(42);
  });

  it('unlinking and deleting clean up both sides', () => {
    const linked = link(make(), 'a1', 'b1');
    const a1 = get(linked, 'a', 'a1');
    const un = change(linked, 'a', [{ ...a1, data: { ...a1.data, bs: [] } }]);
    expect(get(un, 'b', 'b1').data.as).toEqual([]);
    expect(get(un, 'a', 'a1').data.bprice).toBe('');
    // delete b1 while a1 still links it: the stores remove the row first, then propagate
    const without: Snapshot = { ...linked, b: { ...linked.b, records: [] } };
    const after = apply(without, 'b', [], propagate(without, 'b', [], { removed: ['b1'] }));
    expect(get(after, 'a', 'a1').data.bs).toEqual([]);
    expect(get(after, 'a', 'a1').data.bprice).toBe('');
  });

  it('knows which fields depend on a field before it is deleted', () => {
    const snap = make();
    const lk = snap.a.fields.find((x) => x.key === 'bs')!;
    expect(dependentsOf(snap, 'a', lk).map((d) => d.field.key).sort()).toEqual(['as', 'bprice']);
    const price = snap.b.fields.find((x) => x.key === 'price')!;
    expect(dependentsOf(snap, 'b', price).map((d) => d.field.key)).toEqual(['bprice']);
  });

  it('does nothing (and costs nothing) when no table has links', () => {
    const snap: Snapshot = { a: { fields: [f('name', 'text')], records: [row('a', 'a1')] } };
    expect(propagate(snap, 'a', snap.a.records).size).toBe(0);
  });
});

describe('secret vault', () => {
  it('encrypts with AES-GCM: ciphertext differs every time, never contains the secret, round-trips, rejects tampering', async () => {
    const key = await testKey();
    const secret = 'TbDy6ILkhgiaMOjfAF-KB-Jbmk2OmuaUapSSxxxx';
    const a = await encryptSecret(secret, key), b = await encryptSecret(secret, key);
    expect(isEncrypted(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain(secret.slice(0, 8));
    expect(await decryptSecret(a, key)).toBe(secret);
    const tampered = a.slice(0, -4) + (a.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(decryptSecret(tampered, key)).rejects.toThrow();
    await expect(decryptSecret(a, await testKey())).rejects.toThrow(/cannot be decrypted/);
  });
});
