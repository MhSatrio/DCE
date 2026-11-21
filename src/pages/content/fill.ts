/**
 * The values of a spreadsheet-style fill: dragging the fill handle of a selection down copies its rows (repeated, as
 * spreadsheets do), and with Shift or Ctrl held a column of numbers counts on instead (1, 2, 3 … or 10, 20 → 30, 40).
 * Pure: the caller writes the result with the same planner as paste, so links, images and read-only fields behave alike.
 */

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** Counts on from a column of plain numbers: the step is the last difference (1 for a single number). Null when not numbers. */
export function seriesValues(col: string[], count: number): string[] | null {
  if (!col.length || !col.every((t) => PLAIN_NUMBER.test(t.trim()))) return null;
  const nums = col.map((t) => Number(t.trim()));
  const last = nums[nums.length - 1];
  const step = nums.length >= 2 ? last - nums[nums.length - 2] : 1;
  return Array.from({ length: count }, (_, k) => String(Number((last + step * (k + 1)).toFixed(10))));
}

/**
 * `source` is the selected block (rows of cell texts). Returns `count` new rows below it, with the same columns.
 * `series` counts on the numeric columns; any other column is copied, repeating the block's rows in turn.
 */
export function fillGrid(source: string[][], count: number, series: boolean): string[][] {
  const n = source.length;
  if (n === 0 || count <= 0) return [];
  const width = source[0].length;
  const columns: string[][] = [];
  for (let c = 0; c < width; c++) {
    const col = source.map((r) => r[c] ?? '');
    const counted = series ? seriesValues(col, count) : null;
    columns.push(counted ?? Array.from({ length: count }, (_, k) => col[k % n]));
  }
  return Array.from({ length: count }, (_, k) => columns.map((col) => col[k]));
}
