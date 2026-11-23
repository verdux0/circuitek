/**
 * Dock layout described as data (columns → blocks → tabs → panels), after Photopea's
 * right-hand column. The layout only stores panel ids; what a panel shows lives in the
 * panel registry (dock.ts). Nothing here knows about the DOM, so the same layout can later be
 * edited by drag and drop or saved to localStorage without touching the panels.
 */

export type PanelId = string;

export interface Block {
  id: string;
  /** Panels shown as tabs of this block, in order. */
  tabs: PanelId[];
  activeTab: PanelId;
  /** Relative height inside the column (flex-grow). */
  size: number;
  /** Folded: only its header shows. */
  collapsed?: boolean;
}

export interface Column {
  id: string;
  side: 'left' | 'right';
  /** Width in px. */
  width: number;
  collapsed: boolean;
  blocks: Block[];
}

export interface FloatingPanel {
  panel: PanelId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  columns: Column[];
  floating: FloatingPanel[];
  /** Panels turned off from Ventana: they keep their place in the layout, just not shown. */
  hidden: PanelId[];
}

/** Default arrangement: effect controls on the left; properties / projects and layers on the right. */
export function defaultLayout(): Layout {
  return {
    columns: [
      {
        id: 'left',
        side: 'left',
        width: 264,
        collapsed: false,
        blocks: [
          { id: 'left-fx', tabs: ['effects', 'motion'], activeTab: 'effects', size: 6 },
          { id: 'left-stages', tabs: ['stages'], activeTab: 'stages', size: 4 },
        ],
      },
      {
        id: 'right',
        side: 'right',
        width: 272,
        collapsed: false,
        blocks: [
          { id: 'right-props', tabs: ['properties', 'projects'], activeTab: 'properties', size: 4 },
          { id: 'right-layers', tabs: ['layers'], activeTab: 'layers', size: 5 },
        ],
      },
    ],
    floating: [],
    hidden: [],
  };
}

export function isHidden(l: Layout, id: PanelId): boolean {
  return l.hidden.includes(id);
}

/** Ventana → panel: shows or hides a panel (a pure layout change). */
export function setPanelVisible(l: Layout, id: PanelId, visible: boolean): Layout {
  const hidden = l.hidden.filter((h) => h !== id);
  if (!visible) hidden.push(id);
  return { ...l, hidden };
}

/** The block that holds a panel (by id, wherever it is docked). */
export function blockOf(l: Layout, id: PanelId): Block | undefined {
  for (const c of l.columns) for (const b of c.blocks) if (b.tabs.includes(id)) return b;
  return undefined;
}

/** Makes a panel the active tab of its block (and shows it). */
export function focusPanel(l: Layout, id: PanelId): Layout {
  const next = setPanelVisible(l, id, true);
  return {
    ...next,
    columns: next.columns.map((c) => ({ ...c, blocks: c.blocks.map((b) => (b.tabs.includes(id) ? { ...b, activeTab: id } : b)) })),
  };
}

/* ------------------------------ sizes (resizable panels) ------------------------------ */

/** Column width limits (px). */
export const COL_MIN = 200;
export const COL_MAX = 520;
/** Width of a folded column (a strip with the unfold button). */
export const COL_FOLDED = 28;
/** Dragging a column this far below COL_MIN folds it. */
export const FOLD_SLACK = 60;
/** The canvas never gets narrower than this because of the columns. */
export const CANVAS_MIN = 320;
/** Smallest height (px) of an unfolded block while dragging the separator between two blocks. */
export const BLOCK_MIN = 72;
/** Bottom sheets (phones): height limits. */
export const SHEET_MIN = 160;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Largest width a column may take on a window `viewportW` wide, next to the other columns. */
export function maxColumnWidth(l: Layout, id: string, viewportW: number): number {
  const others = l.columns.filter((c) => c.id !== id).reduce((a, c) => a + (c.collapsed ? COL_FOLDED : c.width), 0);
  return clamp(viewportW - CANVAS_MIN - others, COL_MIN, COL_MAX);
}

/** Width a column is drawn with right now (its own width, kept inside the limits of this window). */
export function effectiveWidth(l: Layout, id: string, viewportW: number): number {
  const c = l.columns.find((x) => x.id === id);
  if (!c) return 0;
  if (c.collapsed) return COL_FOLDED;
  return clamp(c.width, COL_MIN, maxColumnWidth(l, id, viewportW));
}

/** Sets a column's width; a width far below the minimum folds it, a real width unfolds it. */
export function setColumnWidth(l: Layout, id: string, w: number, viewportW: number): Layout {
  return {
    ...l,
    columns: l.columns.map((c) => {
      if (c.id !== id) return c;
      if (w < COL_MIN - FOLD_SLACK) return { ...c, collapsed: true };
      return { ...c, collapsed: false, width: Math.round(clamp(w, COL_MIN, maxColumnWidth(l, id, viewportW))) };
    }),
  };
}

export function setColumnCollapsed(l: Layout, id: string, collapsed: boolean): Layout {
  return { ...l, columns: l.columns.map((c) => (c.id === id ? { ...c, collapsed } : c)) };
}

export function setBlockCollapsed(l: Layout, blockId: string, collapsed: boolean): Layout {
  return { ...l, columns: l.columns.map((c) => ({ ...c, blocks: c.blocks.map((b) => (b.id === blockId ? { ...b, collapsed } : b)) })) };
}

/**
 * The separator between blocks `a` and `b` (neighbours in a column) moved: their pixel heights are
 * now ha / hb. Their sizes keep their sum, so the rest of the column does not move.
 */
export function resizeBlocks(l: Layout, a: string, b: string, ha: number, hb: number): Layout {
  const all = l.columns.flatMap((c) => c.blocks);
  const A = all.find((x) => x.id === a);
  const B = all.find((x) => x.id === b);
  if (!A || !B || ha + hb <= 0) return l;
  const sum = A.size + B.size;
  const sa = Math.max(0.05, (sum * ha) / (ha + hb));
  const sb = Math.max(0.05, sum - sa);
  return {
    ...l,
    columns: l.columns.map((c) => ({ ...c, blocks: c.blocks.map((x) => (x.id === a ? { ...x, size: sa } : x.id === b ? { ...x, size: sb } : x)) })),
  };
}

/** Default width / block sizes of one column (double click on its separator). */
export function resetColumn(l: Layout, id: string): Layout {
  const d = defaultLayout().columns.find((c) => c.id === id);
  if (!d) return l;
  return {
    ...l,
    columns: l.columns.map((c) => (c.id === id ? { ...c, width: d.width, collapsed: false, blocks: c.blocks.map((b) => ({ ...b, size: d.blocks.find((x) => x.id === b.id)?.size ?? b.size, collapsed: false })) } : c)),
  };
}

/** Default sizes of two neighbour blocks (double click on the separator between them). */
export function resetBlocks(l: Layout, a: string, b: string): Layout {
  const d = defaultLayout().columns.flatMap((c) => c.blocks);
  const size = (id: string, cur: number) => d.find((x) => x.id === id)?.size ?? cur;
  return {
    ...l,
    columns: l.columns.map((c) => ({ ...c, blocks: c.blocks.map((x) => (x.id === a || x.id === b ? { ...x, size: size(x.id, x.size), collapsed: false } : x)) })),
  };
}

/** Bottom sheet height (phones) inside an area `areaH` tall. */
export function clampSheet(h: number, areaH: number): number {
  return Math.round(clamp(h, SHEET_MIN, Math.max(SHEET_MIN, areaH - 40)));
}

/**
 * Validates a layout read from storage against the default one: the structure (columns, blocks,
 * which panels go where) always comes from the default; only sizes, folds, active tabs and
 * hidden panels are taken from storage, and only when they are well-formed and in range.
 * Anything else (old versions, another screen, garbage) falls back to the default.
 */
export function sanitizeLayout(raw: unknown): Layout {
  const d = defaultLayout();
  if (!raw || typeof raw !== 'object') return d;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : def);
  const cols = Array.isArray(o.columns) ? (o.columns as Record<string, unknown>[]) : [];
  const ids = new Set(d.columns.flatMap((c) => c.blocks.flatMap((b) => b.tabs)));
  return {
    columns: d.columns.map((c) => {
      const rc = cols.find((x) => x && typeof x === 'object' && x.id === c.id);
      if (!rc) return c;
      const rbs = Array.isArray(rc.blocks) ? (rc.blocks as Record<string, unknown>[]) : [];
      return {
        ...c,
        width: Math.round(num(rc.width, COL_MIN, COL_MAX, c.width)),
        collapsed: rc.collapsed === true,
        blocks: c.blocks.map((b) => {
          const rb = rbs.find((x) => x && typeof x === 'object' && x.id === b.id);
          if (!rb) return b;
          return {
            ...b,
            size: num(rb.size, 0.05, 100, b.size),
            collapsed: rb.collapsed === true,
            activeTab: b.tabs.includes(rb.activeTab as string) ? (rb.activeTab as string) : b.activeTab,
          };
        }),
      };
    }),
    // Floating panels belong to one session on a phone: never restored.
    floating: [],
    hidden: Array.isArray(o.hidden) ? [...new Set(o.hidden.filter((h): h is string => typeof h === 'string' && ids.has(h)))] : [],
  };
}
