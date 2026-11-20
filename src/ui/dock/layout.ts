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

/** Default arrangement: effect controls on the left, layers and projects on the right. */
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
          { id: 'right-layers', tabs: ['layers'], activeTab: 'layers', size: 5 },
          { id: 'right-projects', tabs: ['projects'], activeTab: 'projects', size: 2 },
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

/** Panels in layout order (for the Ventana menu). */
export function allPanels(l: Layout): PanelId[] {
  return [...l.columns.flatMap((c) => c.blocks.flatMap((b) => b.tabs)), ...l.floating.map((f) => f.panel)];
}
