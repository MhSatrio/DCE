import { describe, expect, it } from 'vitest';
import { actionRuns, type Cur } from '../../src/automation/steps';
import type { AutoFilter } from '../../src/db/schema';

/** A website item (no table): its values are its fields. */
const item = (values: Record<string, unknown>): Cur => ({ key: 'k1', title: 'Item', values, base: 'k1' }) as unknown as Cur;
const eq = (id: string, field: string, value: string): AutoFilter['conditions'][number] => ({ id, field, op: 'eq', value });

describe('an action’s own condition', () => {
  it('no condition, or an empty one, runs the action for every item', () => {
    expect(actionRuns(undefined, item({ name: 'Alpha' }))).toBe(true);
    expect(actionRuns({ join: 'and', conditions: [] }, item({ name: 'Alpha' }))).toBe(true);
  });

  it('the item must match the conditions: all of them (and) or any of them (or)', () => {
    const alpha = item({ name: 'Alpha', stage: 'Ready' });
    expect(actionRuns({ join: 'and', conditions: [eq('a', 'name', 'Alpha')] }, alpha)).toBe(true);
    expect(actionRuns({ join: 'and', conditions: [eq('a', 'name', 'Bravo')] }, alpha)).toBe(false);
    expect(actionRuns({ join: 'and', conditions: [eq('a', 'name', 'Alpha'), eq('b', 'stage', 'Done')] }, alpha)).toBe(false);
    expect(actionRuns({ join: 'or', conditions: [eq('a', 'name', 'Alpha'), eq('b', 'stage', 'Done')] }, alpha)).toBe(true);
  });

  it('a condition with no value is ignored, as in the table filters', () => {
    expect(actionRuns({ join: 'and', conditions: [eq('a', 'name', '')] }, item({ name: 'Bravo' }))).toBe(true);
  });

  it('a website item’s field named like a built-in field (title) is read from its values', () => {
    expect(actionRuns({ join: 'and', conditions: [eq('a', 'title', 'Hello')] }, item({ title: 'Hello' }))).toBe(true);
  });
});
