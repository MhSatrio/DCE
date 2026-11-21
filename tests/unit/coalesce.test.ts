import { describe, expect, it } from 'vitest';
import { coalesce } from '../../src/db/coalesce';

const pause = () => new Promise((r) => setTimeout(r, 5));

describe('a task that is asked again while it runs', () => {
  it('is not dropped: it runs once more after the run in progress, so the last request is the one it sees', async () => {
    let value = 1;
    const seen: number[] = [];
    const task = coalesce(async () => { seen.push(value); await pause(); });
    const calls = [task('k')];
    value = 2; calls.push(task('k'));
    value = 3; calls.push(task('k'));
    await Promise.all(calls);
    expect(seen).toEqual([1, 3]);
  });

  it('a request that finds nothing running runs once', async () => {
    const seen: string[] = [];
    const task = coalesce(async (key) => { seen.push(key); });
    await task('a');
    await task('a');
    expect(seen).toEqual(['a', 'a']);
  });

  it('different keys do not wait for each other', async () => {
    const order: string[] = [];
    const task = coalesce(async (key) => { order.push(`start ${key}`); await pause(); order.push(`end ${key}`); });
    await Promise.all([task('x'), task('y')]);
    expect(order.slice(0, 2)).toEqual(['start x', 'start y']);
  });
});
