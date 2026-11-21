import { describe, expect, it } from 'vitest';
import { fillGrid, seriesValues } from '../../src/pages/content/fill';

describe('fill handle: copying', () => {
  it('one value is copied into every new row', () => {
    expect(fillGrid([['Hello']], 3, false)).toEqual([['Hello'], ['Hello'], ['Hello']]);
  });

  it('a block of several rows repeats in turn, as a spreadsheet does', () => {
    expect(fillGrid([['a'], ['b']], 5, false)).toEqual([['a'], ['b'], ['a'], ['b'], ['a']]);
  });

  it('each column is filled on its own, with the same columns', () => {
    expect(fillGrid([['x', '1'], ['y', '2']], 2, false)).toEqual([['x', '1'], ['y', '2']]);
  });

  it('numbers are copied, not counted, without Shift or Ctrl', () => {
    expect(fillGrid([['5']], 2, false)).toEqual([['5'], ['5']]);
  });

  it('nothing to fill gives nothing', () => {
    expect(fillGrid([['a']], 0, false)).toEqual([]);
    expect(fillGrid([], 3, true)).toEqual([]);
  });
});

describe('fill handle: counting on with Shift or Ctrl', () => {
  it('a single number counts up by 1', () => {
    expect(fillGrid([['5']], 3, true)).toEqual([['6'], ['7'], ['8']]);
  });

  it('two numbers continue their step', () => {
    expect(seriesValues(['10', '20'], 2)).toEqual(['30', '40']);
    expect(seriesValues(['3', '1'], 2)).toEqual(['-1', '-3']);
  });

  it('decimals keep their step without float noise', () => {
    expect(seriesValues(['0.1', '0.2'], 2)).toEqual(['0.3', '0.4']);
    expect(seriesValues(['1.5'], 2)).toEqual(['2.5', '3.5']);
  });

  it('a column that is not all numbers is copied instead (its numbers are not guessed)', () => {
    expect(seriesValues(['x', '5'], 2)).toBeNull();
    expect(fillGrid([['x'], ['5']], 2, true)).toEqual([['x'], ['5']]);
  });

  it('a blank cell is not a number, so that column is copied', () => {
    expect(seriesValues(['', '4'], 1)).toBeNull();
  });

  it('a mixed block counts its numeric columns and copies the others', () => {
    expect(fillGrid([['Item 1', '100'], ['Item 2', '200']], 2, true)).toEqual([['Item 1', '300'], ['Item 2', '400']]);
  });
});
