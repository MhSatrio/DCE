import { describe, expect, it } from 'vitest';
import { deleteAtOf } from '../../src/cloud/retention';
import { keyFromPublicUrl } from '../../src/cloud/client';

describe('when an uploaded file is deleted', () => {
  const now = Date.parse('2026-11-16T10:00:00');

  it('kept for some hours: deleted that many hours later; kept for ever: never', () => {
    expect(deleteAtOf({ keepHours: 24 }, now)).toBe(now + 24 * 3_600_000);
    expect(deleteAtOf({}, now)).toBeUndefined();
    expect(deleteAtOf({ keepHours: 0 }, now)).toBeUndefined();
  });

  it('kept until a date and time: deleted at that moment (local time)', () => {
    expect(deleteAtOf({ keepUntil: '2026-11-17T09:30' }, now)).toBe(Date.parse('2026-11-17T09:30'));
    expect(deleteAtOf({ keepUntil: 'not a date' }, now)).toBeUndefined();
  });
});

describe('the file behind a public address', () => {
  const base = 'https://pub.example.com';

  it('is the bucket key, decoded, under the connection’s folder', () => {
    expect(keyFromPublicUrl(base, 'batch', 'https://pub.example.com/batch/card%201.png')).toBe('batch/card 1.png');
  });

  it('is refused for another site, another folder, or an empty address, so nothing outside the folder is deleted', () => {
    expect(keyFromPublicUrl(base, 'batch', 'https://other.example.org/batch/card.png')).toBeNull();
    expect(keyFromPublicUrl(base, 'batch', 'https://pub.example.com/photos/card.png')).toBeNull();
    expect(keyFromPublicUrl(base, 'batch', 'https://pub.example.com/')).toBeNull();
    expect(keyFromPublicUrl('', '', 'https://pub.example.com/batch/card.png')).toBeNull();
  });

  it('without a folder prefix, any file of the bucket’s public address is its key', () => {
    expect(keyFromPublicUrl(base, '', 'https://pub.example.com/a/b.png')).toBe('a/b.png');
  });
});
