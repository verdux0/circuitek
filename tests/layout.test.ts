import { describe, expect, it } from 'vitest';
import {
  CANVAS_MIN, COL_FOLDED, COL_MAX, COL_MIN, FOLD_SLACK, SHEET_MIN, clampSheet, defaultLayout, effectiveWidth, maxColumnWidth, resetBlocks, resetColumn,
  resizeBlocks, sanitizeLayout, setBlockCollapsed, setColumnCollapsed, setColumnWidth,
} from '../src/ui/dock/layout';

const W = 1400;

describe('column widths', () => {
  it('a width inside the limits is kept, outside it is clamped', () => {
    const l = setColumnWidth(defaultLayout(), 'left', 350, W);
    expect(l.columns[0].width).toBe(350);
    expect(setColumnWidth(defaultLayout(), 'left', 9999, W).columns[0].width).toBe(COL_MAX);
    expect(setColumnWidth(defaultLayout(), 'left', COL_MIN - 10, W).columns[0].width).toBe(COL_MIN);
  });
  it('the canvas always keeps CANVAS_MIN px on a narrow window', () => {
    const narrow = 900;
    const l = setColumnWidth(defaultLayout(), 'left', COL_MAX, narrow);
    const right = effectiveWidth(l, 'right', narrow);
    expect(l.columns[0].width + right).toBeLessThanOrEqual(narrow - CANVAS_MIN);
    expect(maxColumnWidth(defaultLayout(), 'left', 300)).toBe(COL_MIN); // never below the minimum
  });
  it('a stored width too big for this window is drawn smaller (not rewritten)', () => {
    const l = { ...defaultLayout() };
    l.columns = l.columns.map((c) => (c.id === 'left' ? { ...c, width: COL_MAX } : c));
    expect(effectiveWidth(l, 'left', 900)).toBe(900 - CANVAS_MIN - 272);
    expect(l.columns[0].width).toBe(COL_MAX);
  });
  it('dragging far below the minimum folds the column; a real width unfolds it', () => {
    const folded = setColumnWidth(defaultLayout(), 'right', COL_MIN - FOLD_SLACK - 1, W);
    expect(folded.columns[1].collapsed).toBe(true);
    expect(folded.columns[1].width).toBe(272); // the width to come back to is kept
    expect(effectiveWidth(folded, 'right', W)).toBe(COL_FOLDED);
    const back = setColumnWidth(folded, 'right', 300, W);
    expect(back.columns[1]).toMatchObject({ collapsed: false, width: 300 });
    expect(setColumnCollapsed(back, 'right', true).columns[1].collapsed).toBe(true);
  });
  it('reset restores the default width, sizes and folds of one column', () => {
    let l = setColumnWidth(defaultLayout(), 'left', 400, W);
    l = setBlockCollapsed(l, 'left-stages', true);
    const r = resetColumn(l, 'left');
    expect(r.columns[0]).toEqual(defaultLayout().columns[0].blocks ? { ...defaultLayout().columns[0], blocks: defaultLayout().columns[0].blocks.map((b) => ({ ...b, collapsed: false })) } : null);
  });
});

describe('blocks', () => {
  it('resizing two neighbours keeps the sum of their sizes', () => {
    const l = resizeBlocks(defaultLayout(), 'right-props', 'right-layers', 300, 100);
    const [a, b] = l.columns[1].blocks;
    expect(a.size + b.size).toBeCloseTo(9);
    expect(a.size / b.size).toBeCloseTo(3);
    const r = resetBlocks(l, 'right-props', 'right-layers');
    expect(r.columns[1].blocks.map((x) => x.size)).toEqual([4, 5]);
  });
  it('fold / unfold a block', () => {
    const l = setBlockCollapsed(defaultLayout(), 'left-fx', true);
    expect(l.columns[0].blocks[0].collapsed).toBe(true);
    expect(setBlockCollapsed(l, 'left-fx', false).columns[0].blocks[0].collapsed).toBe(false);
  });
});

describe('bottom sheets', () => {
  it('height stays between the minimum and the area minus a margin', () => {
    expect(clampSheet(10, 700)).toBe(SHEET_MIN);
    expect(clampSheet(5000, 700)).toBe(660);
    expect(clampSheet(400, 700)).toBe(400);
  });
});

describe('stored layout', () => {
  it('garbage, null or other types give the default', () => {
    for (const x of [null, undefined, 3, 'x', [], { columns: 'no' }]) expect(sanitizeLayout(x)).toEqual(defaultLayout());
  });
  it('a stored layout round-trips', () => {
    let l = setColumnWidth(defaultLayout(), 'left', 333, W);
    l = setBlockCollapsed(l, 'right-layers', true);
    l = resizeBlocks(l, 'left-fx', 'left-stages', 200, 200);
    l = { ...l, hidden: ['projects'] };
    const back = sanitizeLayout(JSON.parse(JSON.stringify(l)));
    expect(back.columns[0].width).toBe(333);
    expect(back.columns[0].blocks.map((b) => b.size)).toEqual(l.columns[0].blocks.map((b) => b.size));
    expect(back.columns[1].blocks.map((b) => !!b.collapsed)).toEqual([false, true]);
    expect(back.hidden).toEqual(['projects']);
    // Stable: a second round trip changes nothing.
    expect(sanitizeLayout(JSON.parse(JSON.stringify(back)))).toEqual(back);
  });
  it('out-of-range values are clamped, unknown ids and floating panels are dropped', () => {
    const raw = {
      columns: [{ id: 'left', width: 99999, collapsed: 'yes', blocks: [{ id: 'left-fx', size: -5, activeTab: 'nope' }, { id: 'zzz', size: 3 }] }, { id: 'bogus' }],
      floating: [{ panel: 'layers', x: 0, y: 0, w: 1, h: 1 }],
      hidden: ['layers', 'unknown', 7, 'layers'],
    };
    const l = sanitizeLayout(raw);
    expect(l.columns[0].width).toBe(COL_MAX);
    expect(l.columns[0].collapsed).toBe(false);
    expect(l.columns[0].blocks[0]).toMatchObject({ size: 0.05, activeTab: 'effects' });
    expect(l.columns[0].blocks.map((b) => b.id)).toEqual(['left-fx', 'left-stages']);
    expect(l.columns.map((c) => c.id)).toEqual(['left', 'right']);
    expect(l.floating).toEqual([]);
    expect(l.hidden).toEqual(['layers']);
  });
});
